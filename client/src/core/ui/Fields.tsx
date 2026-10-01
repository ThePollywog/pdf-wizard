import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Check, ChevronDown, ChevronUp, Minus } from 'lucide-react';
import type { IconType } from '../types';

const cx = (...c: unknown[]) => c.filter((x) => typeof x === 'string' && x).join(' ');

function FieldShell({
  label,
  htmlFor,
  error,
  help,
  className,
  children,
  inline,
  style,
}: {
  label?: ReactNode;
  htmlFor?: string;
  error?: ReactNode;
  help?: ReactNode;
  className?: string;
  children: ReactNode;
  inline?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className={cx('field', inline && 'field-inline', error && 'has-error', className)} style={style}>
      {label && (
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {error ? <div className="field-error">{error}</div> : help ? <div className="field-help">{help}</div> : null}
    </div>
  );
}

// ── TextField / TextArea ────────────────────────────────────────────────────

export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size'> & {
  label?: ReactNode;
  value: string;
  onChange(v: string): void;
  error?: ReactNode;
  help?: ReactNode;
  icon?: IconType;
  /** Content at the end of the input (e.g. a unit or a button). */
  end?: ReactNode;
  size?: 'sm' | 'md';
  inline?: boolean;
  fieldClassName?: string;
  ref?: Ref<HTMLInputElement>;
};

export function TextField({ label, value, onChange, error, help, icon: Icon, end, size = 'md', inline, className, fieldClassName, id, ...rest }: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <FieldShell label={label} htmlFor={inputId} error={error} help={help} inline={inline} className={fieldClassName}>
      <div className={cx('input-wrap', `input-${size}`, Icon && 'has-icon', end != null && 'has-end', rest.disabled && 'is-disabled')}>
        {Icon && <Icon className="input-icon" size={size === 'sm' ? 14 : 16} strokeWidth={1.75} />}
        <input
          id={inputId}
          className={cx('input', className)}
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          {...rest}
        />
        {end != null && <div className="input-end">{end}</div>}
      </div>
    </FieldShell>
  );
}

export type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & {
  label?: ReactNode;
  value: string;
  onChange(v: string): void;
  error?: ReactNode;
  help?: ReactNode;
  /** Grow with content up to maxRows. */
  autoGrow?: boolean;
  maxRows?: number;
  fieldClassName?: string;
  ref?: Ref<HTMLTextAreaElement>;
};

export function TextArea({ label, value, onChange, error, help, className, autoGrow, maxRows = 12, fieldClassName, id, rows = 3, ...rest }: TextAreaProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!autoGrow || !ref.current) return;
    const el = ref.current;
    el.style.height = 'auto';
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight + 2, lh * maxRows + 16)}px`;
  }, [value, autoGrow, maxRows]);
  return (
    <FieldShell label={label} htmlFor={inputId} error={error} help={help} className={fieldClassName}>
      <textarea
        ref={ref}
        id={inputId}
        rows={rows}
        className={cx('input', 'textarea', className)}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
    </FieldShell>
  );
}

// ── NumberField ─────────────────────────────────────────────────────────────

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  disabled,
  precision,
  width,
  size = 'md',
  className,
  inline,
  'aria-label': ariaLabel,
}: {
  label?: ReactNode;
  value: number;
  onChange(n: number): void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  /** Decimal places shown (default: derived from step). */
  precision?: number;
  width?: number | string;
  size?: 'sm' | 'md';
  className?: string;
  inline?: boolean;
  'aria-label'?: string;
}) {
  const id = useId();
  const decimals = precision ?? (String(step).split('.')[1]?.length ?? 0);
  const fmt = (n: number) => (Number.isFinite(n) ? String(Number(n.toFixed(decimals))) : '');
  const [text, setText] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

  const clampV = (n: number) => {
    let v = n;
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    return Number(v.toFixed(decimals));
  };
  const commit = (raw: string) => {
    const n = parseFloat(raw.replace(',', '.'));
    if (Number.isFinite(n)) {
      const v = clampV(n);
      if (v !== value) onChange(v);
      setText(fmt(v));
    } else setText(fmt(value));
  };
  const bump = (dir: 1 | -1, mult = 1) => {
    const base = Number.isFinite(parseFloat(text)) ? parseFloat(text) : value;
    const v = clampV(base + dir * step * mult);
    setText(fmt(v));
    if (v !== value) onChange(v);
  };

  return (
    <FieldShell label={label} htmlFor={id} className={className} inline={inline}>
      <div className={cx('input-wrap', 'number-field', `input-${size}`, disabled && 'is-disabled')} style={width != null ? { width } : undefined}>
        <input
          id={id}
          className="input"
          inputMode="decimal"
          value={text}
          disabled={disabled}
          aria-label={ariaLabel}
          role="spinbutton"
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max}
          onFocus={(e) => {
            setFocused(true);
            e.currentTarget.select();
          }}
          onBlur={(e) => {
            setFocused(false);
            commit(e.currentTarget.value);
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value);
            else if (e.key === 'ArrowUp') {
              e.preventDefault();
              bump(1, e.shiftKey ? 10 : 1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              bump(-1, e.shiftKey ? 10 : 1);
            }
          }}
        />
        {suffix && <span className="input-suffix">{suffix}</span>}
        <div className="number-steppers">
          <button type="button" tabIndex={-1} aria-label="Increase" disabled={disabled || (max != null && value >= max)} onClick={() => bump(1)}>
            <ChevronUp size={12} strokeWidth={2.25} />
          </button>
          <button type="button" tabIndex={-1} aria-label="Decrease" disabled={disabled || (min != null && value <= min)} onClick={() => bump(-1)}>
            <ChevronDown size={12} strokeWidth={2.25} />
          </button>
        </div>
      </div>
    </FieldShell>
  );
}

// ── Select ──────────────────────────────────────────────────────────────────

export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
  size = 'md',
  width,
  inline,
  'aria-label': ariaLabel,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'size'> & {
  label?: ReactNode;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange(v: T): void;
  size?: 'sm' | 'md';
  width?: number | string;
  inline?: boolean;
}) {
  const id = useId();
  return (
    <FieldShell label={label} htmlFor={id} className={className} inline={inline}>
      <div className={cx('select-wrap', `input-${size}`, disabled && 'is-disabled')} style={width != null ? { width } : undefined}>
        <select
          id={id}
          className="input select"
          value={String(value)}
          disabled={disabled}
          aria-label={ariaLabel}
          onChange={(e) => {
            const o = options.find((x) => String(x.value) === e.target.value);
            if (o) onChange(o.value);
          }}
          {...rest}
        >
          {options.map((o) => (
            <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="select-chevron" size={size === 'sm' ? 14 : 16} strokeWidth={1.75} />
      </div>
    </FieldShell>
  );
}

// ── Checkbox / Switch / Radio ──────────────────────────────────────────────

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  indeterminate,
  description,
  className,
}: {
  label: ReactNode;
  checked: boolean;
  onChange(b: boolean): void;
  disabled?: boolean;
  indeterminate?: boolean;
  description?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <label className={cx('checkbox', disabled && 'is-disabled', className)}>
      <input ref={ref} type="checkbox" className="sr-only-input" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={cx('checkbox-box', (checked || indeterminate) && 'is-checked')} aria-hidden>
        {indeterminate ? <Minus size={12} strokeWidth={3} /> : checked ? <Check size={12} strokeWidth={3} /> : null}
      </span>
      {(label || description) && (
        <span className="choice-text">
          {label && <span className="choice-label">{label}</span>}
          {description && <span className="choice-desc">{description}</span>}
        </span>
      )}
    </label>
  );
}

export function Switch({
  label,
  checked,
  onChange,
  disabled,
  description,
  className,
  'aria-label': ariaLabel,
}: {
  label?: ReactNode;
  checked: boolean;
  onChange(b: boolean): void;
  disabled?: boolean;
  description?: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <label className={cx('switch', disabled && 'is-disabled', className)}>
      <input
        type="checkbox"
        role="switch"
        className="sr-only-input"
        checked={checked}
        disabled={disabled}
        aria-checked={checked}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={cx('switch-track', checked && 'is-checked')} aria-hidden>
        <span className="switch-thumb" />
      </span>
      {(label || description) && (
        <span className="choice-text">
          {label && <span className="choice-label">{label}</span>}
          {description && <span className="choice-desc">{description}</span>}
        </span>
      )}
    </label>
  );
}

export function Radio({
  label,
  checked,
  onChange,
  name,
  value,
  disabled,
  description,
}: {
  label: ReactNode;
  checked: boolean;
  onChange(): void;
  name?: string;
  value?: string;
  disabled?: boolean;
  description?: ReactNode;
}) {
  return (
    <label className={cx('radio', disabled && 'is-disabled')}>
      <input type="radio" className="sr-only-input" name={name} value={value} checked={checked} disabled={disabled} onChange={() => onChange()} />
      <span className={cx('radio-circle', checked && 'is-checked')} aria-hidden />
      <span className="choice-text">
        <span className="choice-label">{label}</span>
        {description && <span className="choice-desc">{description}</span>}
      </span>
    </label>
  );
}

export function RadioGroup<T extends string>({
  value,
  options,
  onChange,
  name,
  label,
  horizontal,
  disabled,
}: {
  value: T;
  options: { value: T; label: ReactNode; description?: ReactNode; disabled?: boolean }[];
  onChange(v: T): void;
  name?: string;
  label?: ReactNode;
  horizontal?: boolean;
  disabled?: boolean;
}) {
  const autoName = useId();
  return (
    <div className={cx('radio-group', horizontal && 'is-horizontal')} role="radiogroup">
      {label && <div className="field-label">{label}</div>}
      <div className="radio-group-items">
        {options.map((o) => (
          <Radio
            key={o.value}
            name={name ?? autoName}
            value={o.value}
            label={o.label}
            description={o.description}
            checked={value === o.value}
            disabled={disabled || o.disabled}
            onChange={() => onChange(o.value)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Slider ──────────────────────────────────────────────────────────────────

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  disabled,
  showValue = true,
  className,
  onChangeEnd,
  'aria-label': ariaLabel,
}: {
  label?: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(n: number): void;
  format?(n: number): string;
  disabled?: boolean;
  showValue?: boolean;
  className?: string;
  /** Called when the user releases the thumb. */
  onChangeEnd?(n: number): void;
  'aria-label'?: string;
}) {
  const id = useId();
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={cx('field', 'slider', disabled && 'is-disabled', className)}>
      {(label || showValue) && (
        <div className="slider-top">
          {label && (
            <label className="field-label" htmlFor={id}>
              {label}
            </label>
          )}
          {showValue && <span className="slider-value">{format ? format(value) : value}</span>}
        </div>
      )}
      <input
        id={id}
        type="range"
        className="slider-input"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        aria-valuetext={format ? format(value) : undefined}
        style={{ ['--pct' as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onChangeEnd?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onChangeEnd?.(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  );
}
