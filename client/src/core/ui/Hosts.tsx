/**
 * Global hosts: modals (actions.openModal), toasts (actions.toast), busy overlay
 * (actions.setBusy / withBusy) and the context menu (showContextMenu). Mount <UIHosts/> once.
 */
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { actions, useApp, type ModalEntry, type Toast } from '../store';
import { LAYER_ATTR, nextLayerOrder } from './layers';
import { ContextMenuHost } from './Menu';
import { ModalHostContext, type ModalHostContextValue } from './Modal';
import { ProgressBar, Spinner } from './Misc';
import { Button } from './Button';

function ModalLayer({ entry, index, isTop }: { entry: ModalEntry; index: number; isTop: boolean }) {
  const [order] = useState(nextLayerOrder);
  const closeFn = useRef<(() => void) | null>(null);
  const down = useRef(false);
  const ctx = useMemo<ModalHostContextValue>(
    () => ({
      dismissable: entry.dismissable,
      isTop,
      registerClose: (fn) => {
        closeFn.current = fn;
      },
    }),
    [entry.dismissable, isTop],
  );
  const dismiss = () => {
    if (!entry.dismissable) return;
    if (closeFn.current) closeFn.current();
    else entry.resolve(undefined);
  };
  return (
    <div className={`modal-layer${isTop ? ' is-top' : ''}`} {...{ [LAYER_ATTR]: order }} style={{ zIndex: 1000 + index * 2 }} aria-hidden={isTop ? undefined : true}>
      <div
        className="modal-backdrop"
        onPointerDown={(e) => (down.current = e.target === e.currentTarget)}
        onClick={(e) => {
          if (down.current && e.target === e.currentTarget) dismiss();
          down.current = false;
        }}
      >
        <ModalHostContext.Provider value={ctx}>{entry.render(entry.resolve)}</ModalHostContext.Provider>
      </div>
    </div>
  );
}

export function ModalHost() {
  const modals = useApp((s) => s.modals);
  if (modals.length === 0) return null;
  return createPortal(
    <>
      {modals.map((m, i) => (
        <ModalLayer key={m.id} entry={m} index={i} isTop={i === modals.length - 1} />
      ))}
    </>,
    document.body,
  );
}

const TOAST_ICONS = { info: Info, success: CircleCheck, error: CircleAlert, warning: TriangleAlert } as const;

function ToastView({ t }: { t: Toast }) {
  const Icon = TOAST_ICONS[t.kind] ?? Info;
  return (
    <div className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'} data-testid="toast" data-kind={t.kind}>
      <Icon className="toast-icon" size={18} strokeWidth={2} />
      <div className="toast-message">{t.message}</div>
      {t.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            actions.dismissToast(t.id);
            t.action!.run();
          }}
        >
          {t.action.label}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => actions.dismissToast(t.id)}>
        <X size={16} strokeWidth={2} />
      </button>
    </div>
  );
}

export function ToastHost() {
  const toasts = useApp((s) => s.toasts);
  return createPortal(
    <div className="toast-host" aria-live="polite" data-testid="toasts">
      {toasts.map((t) => (
        <ToastView key={t.id} t={t} />
      ))}
    </div>,
    document.body,
  );
}

export function BusyOverlay() {
  const busy = useApp((s) => s.busy);
  if (!busy) return null;
  return createPortal(
    <div className="busy-overlay" data-testid="busy-overlay" role="alertdialog" aria-busy="true" aria-label={busy.label}>
      <div className="busy-card">
        <div className="busy-head">
          <Spinner size={22} />
          <div className="busy-label">{busy.label}</div>
        </div>
        <ProgressBar value={busy.progress} />
        {busy.progress != null && <div className="busy-pct">{Math.round(busy.progress * 100)}%</div>}
        {busy.cancel && (
          <div className="busy-actions">
            <Button size="sm" onClick={() => busy.cancel?.()}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** All global UI hosts. The shell mounts this once. */
export function UIHosts() {
  return (
    <>
      <ModalHost />
      <ContextMenuHost />
      <BusyOverlay />
      <ToastHost />
    </>
  );
}
