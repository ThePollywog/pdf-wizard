import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LAYER_ATTR, focusableElements, nextLayerOrder, useEscapeLayer, useOutsidePointerDown } from './layers';
import { useFloating, type AnchorRect, type Placement } from './position';

export interface PopoverProps {
  /** Element (or rect) the popover is attached to. */
  anchor?: HTMLElement | AnchorRect | null;
  open: boolean;
  onClose(): void;
  children: ReactNode;
  placement?: Placement;
  offset?: number;
  className?: string;
  style?: CSSProperties;
  /** Move focus into the popover when it opens (default true). */
  autoFocus?: boolean;
  /** Close when the user clicks outside (default true). */
  closeOnOutsideClick?: boolean;
  matchWidth?: boolean;
  role?: string;
  'aria-label'?: string;
}

/** Floating panel anchored to an element, rendered in a portal and kept inside the viewport. */
export function Popover(props: PopoverProps) {
  if (!props.open) return null;
  return <PopoverInner {...props} />;
}

function PopoverInner({
  anchor,
  onClose,
  children,
  placement = 'bottom-start',
  offset = 6,
  className,
  style,
  autoFocus = true,
  closeOnOutsideClick = true,
  matchWidth,
  role = 'dialog',
  'aria-label': ariaLabel,
}: PopoverProps) {
  const [order] = useState(nextLayerOrder);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  // Without an explicit anchor, attach to the element the Popover is rendered in.
  const placeholder = useRef<HTMLSpanElement>(null);
  const getAnchor = () => anchorRef.current ?? placeholder.current?.parentElement ?? null;
  const floating = useFloating<HTMLDivElement>({ open: true, anchor: getAnchor, placement, offset, matchWidth });
  const restoreTo = useRef<Element | null>(null);

  useEscapeLayer(true, () => onClose());
  useOutsidePointerDown(
    closeOnOutsideClick,
    () => {
      const a = getAnchor();
      return [floating.ref.current, a instanceof Element ? a : null];
    },
    () => onClose(),
    order,
  );

  useLayoutEffect(() => {
    restoreTo.current = document.activeElement;
    if (!autoFocus) return;
    requestAnimationFrame(() => {
      const el = floating.ref.current;
      if (!el || el.contains(document.activeElement)) return;
      const target = el.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? focusableElements(el)[0] ?? el;
      target.focus({ preventScroll: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      const el = restoreTo.current as HTMLElement | null;
      // Restore focus only if focus was inside the popover when it closed.
      if (el && el.isConnected && (document.activeElement === document.body || !document.activeElement)) el.focus?.({ preventScroll: true });
    },
    [],
  );

  return (
    <>
      <span ref={placeholder} hidden />
      {createPortal(
    <div
      ref={floating.ref}
      {...{ [LAYER_ATTR]: order }}
      role={role}
      aria-label={ariaLabel}
      tabIndex={-1}
      className={`popover popover-${floating.side} ${className ?? ''}`}
      style={{ ...floating.style, ...style }}
    >
      {children}
    </div>,
    document.body,
      )}
    </>
  );
}
