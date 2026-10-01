import { useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, UploadCloud, X } from 'lucide-react';
import type { IconType } from '../types';
import { pickFiles } from '../util';
import { formatShortcut } from './shortcut';
import { Tooltip } from './Tooltip';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ── Spinner / progress ───────────────────────────────────────────────────────

export function Spinner({ size = 20, className, label = 'Loading' }: { size?: number; className?: string; label?: string }) {
  return (
    <span className={cx('spinner', className)} role="progressbar" aria-label={label} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size} height={size}>
        <circle className="spinner-track" cx="12" cy="12" r="9.5" fill="none" strokeWidth="3" />
        <circle className="spinner-arc" cx="12" cy="12" r="9.5" fill="none" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function ProgressBar({ value, label, className, size = 'md' }: { value: number | null; label?: ReactNode; className?: string; size?: 'sm' | 'md' }) {
  const pct = value == null ? null : Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={cx('progress', `progress-${size}`, className)}>
      {label != null && (
        <div className="progress-label">
          <span>{label}</span>
          {pct != null && <span className="progress-value">{pct}%</span>}
        </div>
      )}
      <div
        className={cx('progress-track', pct == null && 'is-indeterminate')}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <div className="progress-fill" style={pct == null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: IconType;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cx('empty-state', compact && 'empty-state-compact', className)}>
      {Icon && (
        <div className="empty-state-icon">
          <Icon size={compact ? 22 : 28} strokeWidth={1.5} />
        </div>
      )}
      <h3 className="empty-state-title">{title}</h3>
      {description && <p className="empty-state-desc">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

// ── Small bits ───────────────────────────────────────────────────────────────

/** Keyboard key. Pass `shortcut` ('mod+s') to format it for the platform. */
export const Kbd = ({ children, shortcut, className }: { children?: ReactNode; shortcut?: string; className?: string }) => (
  <kbd className={cx('kbd', className)}>{shortcut ? formatShortcut(shortcut) : children}</kbd>
);

export const Divider = ({ vertical, className, style }: { vertical?: boolean; className?: string; style?: CSSProperties }) => (
  <div className={cx(vertical ? 'divider-v' : 'divider', className)} role="separator" aria-orientation={vertical ? 'vertical' : 'horizontal'} style={style} />
);

export function Toolbar({ children, className, label, vertical }: { children: ReactNode; className?: string; label?: string; vertical?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Roving arrow-key navigation between the toolbar's buttons.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = vertical ? 'ArrowDown' : 'ArrowRight';
    const prev = vertical ? 'ArrowUp' : 'ArrowLeft';
    if (e.key !== next && e.key !== prev) return;
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const j = (i + (e.key === next ? 1 : -1) + items.length) % items.length;
    items[j]?.focus();
  };
  return (
    <div ref={ref} className={cx('toolbar', vertical && 'toolbar-vertical', className)} role="toolbar" aria-label={label} aria-orientation={vertical ? 'vertical' : 'horizontal'} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  actions: acts,
  onClose,
  onBack,
  icon: Icon,
  iconColor,
  className,
  subtitle,
}: {
  title: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  /** Shows a back arrow before the title. */
  onBack?: () => void;
  icon?: IconType;
  iconColor?: string;
  className?: string;
  subtitle?: ReactNode;
}) {
  return (
    <div className={cx('panel-header', className)}>
      {onBack && (
        <Tooltip label="Back" side="bottom">
          <button type="button" className="icon-btn icon-btn-sm panel-header-back" aria-label="Back" onClick={onBack}>
            <ArrowLeft size={18} strokeWidth={1.75} />
          </button>
        </Tooltip>
      )}
      {Icon && (
        <span className="panel-header-icon" style={iconColor ? { background: iconColor, color: '#fff' } : undefined}>
          <Icon size={16} strokeWidth={1.9} />
        </span>
      )}
      <div className="panel-header-titles">
        <h3 className="panel-header-title">{title}</h3>
        {subtitle && <div className="panel-header-subtitle">{subtitle}</div>}
      </div>
      <div className="panel-header-actions">
        {acts}
        {onClose && (
          <Tooltip label="Close" side="bottom">
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Close panel" onClick={onClose}>
              <X size={16} strokeWidth={1.75} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

// ── Segmented control / tabs ─────────────────────────────────────────────────

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  className,
  label,
  disabled,
}: {
  value: T;
  options: { value: T; label?: string; icon?: IconType; title?: string; disabled?: boolean }[];
  onChange(v: T): void;
  size?: 'sm' | 'md';
  className?: string;
  label?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = enabled[(i + d + enabled.length) % enabled.length];
    if (next) {
      onChange(next.value);
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
    }
  };
  return (
    <div ref={ref} className={cx('segmented', `segmented-${size}`, className)} role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map(({ value: v, label: l, icon: Icon, title, disabled: d }) => {
        const selected = value === v;
        const btn = (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={l ? undefined : title}
            tabIndex={selected ? 0 : -1}
            disabled={disabled || d}
            className={cx('segmented-item', selected && 'is-selected', !l && 'is-icon-only')}
            onClick={() => onChange(v)}
          >
            {Icon && <Icon size={size === 'sm' ? 14 : 16} strokeWidth={1.9} />}
            {l && <span>{l}</span>}
          </button>
        );
        return !l && title ? (
          <Tooltip key={v} label={title} side="bottom">
            {btn}
          </Tooltip>
        ) : (
          btn
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
  size = 'md',
}: {
  tabs: { id: T; label: ReactNode; icon?: IconType; badge?: number; disabled?: boolean }[];
  value: T;
  onChange(id: T): void;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const enabled = tabs.filter((t) => !t.disabled);
    const i = enabled.findIndex((t) => t.id === value);
    let j = i;
    if (e.key === 'ArrowLeft') j = (i - 1 + enabled.length) % enabled.length;
    if (e.key === 'ArrowRight') j = (i + 1) % enabled.length;
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = enabled.length - 1;
    const next = enabled[j];
    if (next) {
      onChange(next.id);
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
    }
  };
  return (
    <div ref={ref} className={cx('tabs', `tabs-${size}`, className)} role="tablist" onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const Icon = t.icon;
        const selected = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            className={cx('tab', selected && 'is-selected')}
            onClick={() => onChange(t.id)}
          >
            {Icon && <Icon size={16} strokeWidth={1.9} />}
            <span>{t.label}</span>
            {t.badge != null && t.badge > 0 && <span className="tab-badge">{t.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ── File drop zone ───────────────────────────────────────────────────────────

function acceptMatcher(accept?: string): (f: File) => boolean {
  if (!accept) return () => true;
  const rules = accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return (f: File) => {
    const name = f.name.toLowerCase();
    const type = (f.type || '').toLowerCase();
    return rules.some((r) => {
      if (r.startsWith('.')) return name.endsWith(r);
      if (r.endsWith('/*')) return type.startsWith(r.slice(0, -1));
      return type === r;
    });
  };
}

export function FileDropZone({
  accept,
  multiple,
  onFiles,
  children,
  className,
  disabled,
  clickable = true,
  title = 'Drag and drop files here',
  hint = 'or click to choose files',
  onReject,
}: {
  accept?: string;
  multiple?: boolean;
  onFiles(files: File[]): void;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  /** Click / Enter opens the file picker (default true). */
  clickable?: boolean;
  title?: ReactNode;
  hint?: ReactNode;
  /** Called with files that did not match `accept`. */
  onReject?(files: File[]): void;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const matches = acceptMatcher(accept);

  const deliver = (files: File[]) => {
    const ok = files.filter(matches);
    const bad = files.filter((f) => !matches(f));
    if (bad.length) onReject?.(bad);
    if (ok.length) onFiles(multiple ? ok : ok.slice(0, 1));
  };
  const open = async () => {
    if (disabled || !clickable) return;
    const files = await pickFiles({ accept, multiple });
    if (files.length) deliver(files);
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  return (
    <div
      className={cx('drop-zone', over && 'is-over', disabled && 'is-disabled', clickable && 'is-clickable', className)}
      data-dropzone=""
      role={clickable ? 'button' : undefined}
      tabIndex={clickable && !disabled ? 0 : undefined}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a, input, select, textarea') && e.target !== e.currentTarget) return;
        void open();
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          void open();
        }
      }}
      onDragEnter={(e) => {
        if (disabled || !hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (disabled || !hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (disabled || !hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setOver(false);
        deliver(Array.from(e.dataTransfer.files));
      }}
    >
      {children ?? (
        <div className="drop-zone-default">
          <UploadCloud size={28} strokeWidth={1.5} />
          <div className="drop-zone-title">{title}</div>
          {clickable && <div className="drop-zone-hint">{hint}</div>}
        </div>
      )}
    </div>
  );
}
