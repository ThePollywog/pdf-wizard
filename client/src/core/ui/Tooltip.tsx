import { cloneElement, useCallback, useEffect, useId, useRef, useState, type FocusEvent as RFocusEvent, type PointerEvent as RPointerEvent, type ReactElement, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { useFloating, type Placement } from './position';
import { formatShortcut } from './shortcut';

type Side = 'top' | 'bottom' | 'left' | 'right';

// "Warm" tooltips: once one tooltip was shown, moving to a neighbour shows instantly.
let lastHiddenAt = 0;
const WARM_MS = 500;

export interface TooltipProps {
  label: ReactNode;
  children: ReactElement;
  side?: Side | Placement;
  /** Keyboard shortcut shown after the label (e.g. 'mod+s'). */
  shortcut?: string;
  /** Show delay in ms (default 500). */
  delay?: number;
  disabled?: boolean;
}

/**
 * Hover/focus tooltip rendered in a portal. The child must be a DOM element or a component that
 * forwards pointer/focus handlers to its root DOM element.
 */
export function Tooltip({ label, children, side = 'top', shortcut, delay = 500, disabled }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const id = useId();
  const floating = useFloating<HTMLDivElement>({ open, anchor: () => anchorRef.current, placement: side as Placement, offset: 6 });

  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  const show = useCallback(
    (el: HTMLElement) => {
      anchorRef.current = el;
      clear();
      const warm = Date.now() - lastHiddenAt < WARM_MS;
      timer.current = window.setTimeout(() => setOpen(true), warm ? 0 : delay);
    },
    [delay],
  );
  const hide = useCallback(() => {
    clear();
    setOpen((o) => {
      if (o) lastHiddenAt = Date.now();
      return false;
    });
  }, []);

  useEffect(() => () => clear(), []);
  useEffect(() => {
    if (!open) return;
    const h = () => hide();
    window.addEventListener('keydown', h, true);
    window.addEventListener('pointerdown', h, true);
    window.addEventListener('wheel', h, { passive: true, capture: true });
    // Hide if the anchor disappears (e.g. button unmounted while hovered).
    const iv = window.setInterval(() => {
      if (!anchorRef.current?.isConnected) hide();
    }, 300);
    return () => {
      window.removeEventListener('keydown', h, true);
      window.removeEventListener('pointerdown', h, true);
      window.removeEventListener('wheel', h, true);
      window.clearInterval(iv);
    };
  }, [open, hide]);
  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  if (!label && !shortcut) return children;
  const props = children.props as Record<string, any>;
  const call = (name: string, e: SyntheticEvent) => {
    const fn = props[name];
    if (typeof fn === 'function') fn(e);
  };

  const child = cloneElement(children, {
    onPointerEnter: (e: RPointerEvent<HTMLElement>) => {
      call('onPointerEnter', e);
      if (!disabled && e.pointerType !== 'touch') show(e.currentTarget);
    },
    onPointerLeave: (e: RPointerEvent<HTMLElement>) => {
      call('onPointerLeave', e);
      hide();
    },
    onFocus: (e: RFocusEvent<HTMLElement>) => {
      call('onFocus', e);
      try {
        if (!disabled && e.currentTarget.matches(':focus-visible')) show(e.currentTarget);
      } catch {
        /* :focus-visible unsupported */
      }
    },
    onBlur: (e: RFocusEvent<HTMLElement>) => {
      call('onBlur', e);
      hide();
    },
    'aria-describedby': open ? id : props['aria-describedby'],
  } as Record<string, unknown>);

  return (
    <>
      {child}
      {open &&
        createPortal(
          <div
            ref={floating.ref}
            id={id}
            role="tooltip"
            className={`tooltip tooltip-${floating.side}`}
            style={floating.style}
          >
            <span>{label}</span>
            {shortcut && <kbd className="tooltip-kbd">{formatShortcut(shortcut)}</kbd>}
          </div>,
          document.body,
        )}
    </>
  );
}
