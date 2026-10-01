/** Promise-based dialog helpers built on actions.openModal. */
import { useState, type ReactNode } from 'react';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { actions } from '../store';
import type { IconType } from '../types';
import { Button, type ButtonVariant } from './Button';
import { TextField } from './Fields';
import { Modal } from './Modal';

export interface ConfirmDialogOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Icon in the title (defaults to a warning icon when `danger`). */
  icon?: IconType;
  width?: number;
}

export function confirmDialog(opts: ConfirmDialogOptions): Promise<boolean> {
  const icon = opts.icon ?? (opts.danger ? TriangleAlert : undefined);
  return actions
    .openModal<boolean>((close) => (
      <Modal
        title={opts.title}
        role="alertdialog"
        icon={icon}
        iconColor={opts.danger ? 'var(--danger)' : undefined}
        width={opts.width ?? 440}
        className="dialog-confirm"
        onClose={() => close(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => close(false)} data-testid="dialog-cancel">
              {opts.cancelLabel ?? 'Cancel'}
            </Button>
            <Button variant={opts.danger ? 'danger' : 'primary'} onClick={() => close(true)} data-testid="dialog-confirm">
              {opts.confirmLabel ?? 'OK'}
            </Button>
          </>
        }
      >
        <div className="dialog-message">{opts.message}</div>
      </Modal>
    ))
    .then((r) => r === true);
}

export interface PromptDialogOptions {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  validate?(v: string): string | null;
  /** Text shown above the field. */
  message?: ReactNode;
  /** Pre-select the part of the default value before the last "." (file names). */
  selectBaseName?: boolean;
  /** Allow confirming an empty value (default false). */
  allowEmpty?: boolean;
  /** Help text under the field. */
  help?: ReactNode;
}

function PromptBody({ opts, close }: { opts: PromptDialogOptions; close(v?: string | null): void }) {
  const [v, setV] = useState(opts.defaultValue ?? '');
  const [touched, setTouched] = useState(false);
  const err = opts.validate?.(v) ?? null;
  const empty = !opts.allowEmpty && v.trim() === '';
  const disabled = !!err || empty;
  const submit = () => {
    setTouched(true);
    if (!disabled) close(v);
  };
  return (
    <Modal
      title={opts.title}
      width={440}
      onClose={() => close(null)}
      footer={
        <>
          <Button onClick={() => close(null)} data-testid="dialog-cancel">
            Cancel
          </Button>
          <Button variant="primary" disabled={disabled} onClick={submit} data-testid="dialog-confirm">
            {opts.confirmLabel ?? 'OK'}
          </Button>
        </>
      }
    >
      {opts.message && <div className="dialog-message dialog-message-above">{opts.message}</div>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          label={opts.label}
          value={v}
          onChange={(nv) => {
            setV(nv);
            setTouched(true);
          }}
          placeholder={opts.placeholder}
          aria-label={opts.label ?? opts.title}
          data-autofocus=""
          data-select-base={opts.selectBaseName ? '' : undefined}
          onFocus={(e) => {
            if (opts.selectBaseName) {
              const t = e.currentTarget;
              const dot = t.value.lastIndexOf('.');
              t.setSelectionRange(0, dot > 0 ? dot : t.value.length);
            } else e.currentTarget.select();
          }}
          error={touched ? err : null}
          help={opts.help}
          data-testid="prompt-input"
        />
      </form>
    </Modal>
  );
}

export function promptDialog(opts: PromptDialogOptions): Promise<string | null> {
  return actions.openModal<string | null>((close) => <PromptBody opts={opts} close={close} />).then((r) => (r === undefined ? null : r));
}

export interface AlertDialogOptions {
  title: string;
  message: ReactNode;
  kind?: 'info' | 'error' | 'warning';
  okLabel?: string;
}

export function alertDialog(opts: AlertDialogOptions): Promise<void> {
  const icon = opts.kind === 'error' ? CircleAlert : opts.kind === 'warning' ? TriangleAlert : opts.kind === 'info' ? Info : undefined;
  const color = opts.kind === 'error' ? 'var(--danger)' : opts.kind === 'warning' ? 'var(--warning)' : 'var(--accent)';
  return actions
    .openModal<void>((close) => (
      <Modal
        title={opts.title}
        role="alertdialog"
        icon={icon}
        iconColor={icon ? color : undefined}
        width={440}
        onClose={() => close()}
        footer={
          <Button variant="primary" onClick={() => close()} data-testid="dialog-confirm">
            {opts.okLabel ?? 'OK'}
          </Button>
        }
      >
        <div className="dialog-message">{opts.message}</div>
      </Modal>
    ))
    .then(() => undefined);
}

export interface ChoiceDialogOption<T extends string> {
  value: T;
  label: string;
  variant?: ButtonVariant;
  /** Rendered on the left side of the footer (e.g. "Don't save"). */
  start?: boolean;
}

/**
 * Dialog with several buttons; resolves with the chosen value, or null when dismissed.
 * Buttons render in order; the last one gets initial focus unless it is a danger button.
 */
export function choiceDialog<T extends string>(opts: {
  title: string;
  message: ReactNode;
  choices: ChoiceDialogOption<T>[];
  icon?: IconType;
  iconColor?: string;
  width?: number;
  dismissable?: boolean;
}): Promise<T | null> {
  return actions
    .openModal<T | null>(
      (close) => {
        const start = opts.choices.filter((c) => c.start);
        const end = opts.choices.filter((c) => !c.start);
        const btn = (c: ChoiceDialogOption<T>) => (
          <Button key={c.value} variant={c.variant ?? 'secondary'} onClick={() => close(c.value)} data-testid={`dialog-choice-${c.value}`}>
            {c.label}
          </Button>
        );
        return (
          <Modal
            title={opts.title}
            role="alertdialog"
            icon={opts.icon}
            iconColor={opts.iconColor}
            width={opts.width ?? 460}
            onClose={() => close(null)}
            footerStart={start.length ? <>{start.map(btn)}</> : undefined}
            footer={<>{end.map(btn)}</>}
          >
            <div className="dialog-message">{opts.message}</div>
          </Modal>
        );
      },
      { dismissable: opts.dismissable },
    )
    .then((r) => (r === undefined ? null : r));
}
