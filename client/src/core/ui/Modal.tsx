import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { IconType } from '../types';
import { LAYER_ATTR, focusableElements, nextLayerOrder, useEscapeLayer } from './layers';
import { Tooltip } from './Tooltip';

/** Provided by ModalHost to each modal it renders. */
export interface ModalHostContextValue {
  dismissable: boolean;
  isTop: boolean;
  /** The Modal registers its onClose so backdrop clicks produce the same result as the × button. */
  registerClose(fn: (() => void) | null): void;
}
export const ModalHostContext = createContext<ModalHostContextValue | null>(null);

export interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  className?: string;
  /** Optional icon shown before the title. */
  icon?: IconType;
  iconColor?: string;
  /** Hide the × button. */
  hideClose?: boolean;
  bodyClassName?: string;
  bodyStyle?: CSSProperties;
  /** Content on the left side of the footer (e.g. a checkbox). */
  footerStart?: ReactNode;
  /** Used when rendered outside of actions.openModal: dismiss on Escape / backdrop (default true). */
  dismissable?: boolean;
  /** Dialog role (alertdialog for confirmations). */
  role?: 'dialog' | 'alertdialog';
}

/**
 * Dialog frame. Use inside actions.openModal(close => <Modal …/>) — the ModalHost supplies the
 * backdrop, stacking and Escape/backdrop dismissal. Rendered anywhere else it creates its own
 * backdrop in a portal.
 */
export function Modal(props: ModalProps) {
  const host = useContext(ModalHostContext);
  if (host) return <ModalFrame {...props} host={host} />;
  return <StandaloneModal {...props} />;
}

function StandaloneModal(props: ModalProps) {
  const [order] = useState(nextLayerOrder);
  const dismissable = props.dismissable !== false;
  const down = useRef(false);
  return createPortal(
    <div className="modal-layer" {...{ [LAYER_ATTR]: order }} style={{ zIndex: 1100 }}>
      <div
        className="modal-backdrop"
        onPointerDown={(e) => (down.current = e.target === e.currentTarget)}
        onClick={(e) => {
          if (down.current && e.target === e.currentTarget && dismissable) props.onClose();
          down.current = false;
        }}
      >
        <ModalFrame {...props} host={{ dismissable, isTop: true, registerClose: () => {} }} />
      </div>
    </div>,
    document.body,
  );
}

function ModalFrame({
  title,
  onClose,
  children,
  footer,
  width = 480,
  className,
  icon: Icon,
  iconColor,
  hideClose,
  bodyClassName,
  bodyStyle,
  footerStart,
  role = 'dialog',
  host,
}: ModalProps & { host: ModalHostContextValue }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    host.registerClose(() => closeRef.current());
    return () => host.registerClose(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEscapeLayer(host.isTop, () => {
    if (host.dismissable) closeRef.current();
  });

  // Initial focus + restore on unmount.
  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      const auto = el.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
      const body = el.querySelector<HTMLElement>('.modal-body');
      const field = body?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]):not(.sr-only-input), textarea:not([disabled]), select:not([disabled])');
      const footerBtns = Array.from(el.querySelectorAll<HTMLButtonElement>('.modal-footer button:not([disabled])'));
      const primary = footerBtns[footerBtns.length - 1];
      const target =
        auto ?? field ?? (primary && !primary.classList.contains('btn-danger') ? primary : footerBtns[0]) ?? focusableElements(el)[0] ?? el;
      target.focus({ preventScroll: true });
      if (target instanceof HTMLInputElement && target.dataset.selectBase !== undefined) {
        const dot = target.value.lastIndexOf('.');
        target.setSelectionRange(0, dot > 0 ? dot : target.value.length);
      }
    }
    return () => {
      if (prev && prev.isConnected) requestAnimationFrame(() => prev.focus?.({ preventScroll: true }));
    };
  }, []);

  // Focus trap (only for the top-most modal).
  useEffect(() => {
    if (!host.isTop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !ref.current) return;
      const els = focusableElements(ref.current);
      if (els.length === 0) {
        e.preventDefault();
        ref.current.focus();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement;
      if (!ref.current.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Element | null;
      if (!ref.current || !t || ref.current.contains(t)) return;
      // Allow focus in floating layers opened on top of the modal (menus, popovers, pickers).
      const layer = t.closest(`[${LAYER_ATTR}]`);
      const myLayer = ref.current.closest(`[${LAYER_ATTR}]`);
      if (layer && myLayer && Number(layer.getAttribute(LAYER_ATTR)) > Number(myLayer.getAttribute(LAYER_ATTR))) return;
      ref.current.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [host.isTop]);

  return (
    <div
      ref={ref}
      className={`modal ${className ?? ''}`}
      role={role}
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="modal"
      style={{ width, maxWidth: 'calc(100vw - 32px)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="modal-header">
        {Icon && (
          <span className="modal-icon" style={iconColor ? { color: iconColor } : undefined}>
            <Icon size={22} strokeWidth={1.75} />
          </span>
        )}
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        {!hideClose && (
          <Tooltip label="Close" side="bottom">
            <button type="button" className="icon-btn icon-btn-sm modal-close" aria-label="Close" onClick={() => onClose()}>
              <X size={18} strokeWidth={1.75} />
            </button>
          </Tooltip>
        )}
      </div>
      <div className={`modal-body ${bodyClassName ?? ''}`} style={bodyStyle}>
        {children}
      </div>
      {(footer || footerStart) && (
        <div className="modal-footer">
          {footerStart && <div className="modal-footer-start">{footerStart}</div>}
          <div className="modal-footer-end">{footer}</div>
        </div>
      )}
    </div>
  );
}
