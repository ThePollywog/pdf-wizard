import { type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react';
import type { IconType } from '../types';
import { Tooltip } from './Tooltip';
import type { Placement } from './position';
import { Spinner } from './Misc';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
export type ButtonSize = 'sm' | 'md' | 'lg';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconType;
  /** Icon shown after the label (e.g. a chevron). */
  iconEnd?: IconType;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Tooltip (in addition to the label). */
  tooltip?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
};

/** Spectrum-style pill button. */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconEnd: IconEnd,
  loading,
  tooltip,
  children,
  className,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 14 : size === 'lg' ? 18 : 16;
  const btn = (
    <button
      type={type}
      className={cx('btn', `btn-${variant}`, `btn-${size}`, !children && 'btn-icon-only', loading && 'is-loading', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : Icon && <Icon size={iconSize} strokeWidth={2} />}
      {children != null && children !== false && <span className="btn-label">{children}</span>}
      {IconEnd && <IconEnd size={iconSize} strokeWidth={2} />}
    </button>
  );
  return tooltip ? <Tooltip label={tooltip}>{btn}</Tooltip> : btn;
}

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconType;
  /** Tooltip text and aria-label. */
  label: string;
  active?: boolean;
  size?: ButtonSize;
  /** Shortcut shown in the tooltip. */
  shortcut?: string;
  tooltipSide?: Placement;
  /** Hide the tooltip (aria-label is kept). */
  noTooltip?: boolean;
  /** Small count badge in the corner. */
  badge?: number | string | null;
  /** Use 'quiet' for toolbar buttons (default) or 'outline' for a bordered square. */
  appearance?: 'quiet' | 'outline';
  ref?: Ref<HTMLButtonElement>;
};

/** Square icon-only button with a tooltip. */
export function IconButton({
  icon: Icon,
  label,
  active,
  size = 'md',
  className,
  shortcut,
  tooltipSide = 'bottom',
  noTooltip,
  badge,
  appearance = 'quiet',
  type = 'button',
  children,
  ...rest
}: IconButtonProps) {
  const iconSize = size === 'sm' ? 16 : size === 'lg' ? 22 : 18;
  const btn = (
    <button
      type={type}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cx('icon-btn', `icon-btn-${size}`, appearance === 'outline' && 'icon-btn-outline', active && 'active', className)}
      {...rest}
    >
      <Icon size={iconSize} strokeWidth={1.75} />
      {children}
      {badge != null && badge !== 0 && badge !== '' && <span className="icon-btn-badge">{typeof badge === 'number' && badge > 99 ? '99+' : badge}</span>}
    </button>
  );
  if (noTooltip) return btn;
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      {btn}
    </Tooltip>
  );
}
