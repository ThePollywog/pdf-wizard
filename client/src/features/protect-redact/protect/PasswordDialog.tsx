/**
 * "Protect using password" (open password + optional permissions) and "Restrict editing"
 * (permissions password only) dialogs.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react';
import { actions, getDoc } from '@/core/store';
import type { DocId, SecuritySettings } from '@/core/types';
import { Button, Checkbox, Modal, Select, TextField } from '@/core/ui';
import {
  CHANGES_OPTIONS, DEFAULT_CHOICES, PRINTING_OPTIONS, choicesToPermissions, permissionsToChoices, type ChangesChoice,
  type PermissionChoices, type PrintingChoice,
} from './permissions';
import { passwordStrength } from './strength';
import { setSecurityUndoable } from './securityHistory';

type Mode = 'password' | 'restrict';

function PasswordInput(props: {
  label: string;
  value: string;
  onChange(v: string): void;
  testid: string;
  error?: string;
  autoFocus?: boolean;
  help?: ReactNode;
}) {
  const [show, setShow] = useState(false);
  return (
    <TextField
      label={props.label}
      type={show ? 'text' : 'password'}
      value={props.value}
      onChange={props.onChange}
      autoComplete="new-password"
      data-testid={props.testid}
      error={props.error}
      help={props.help}
      {...(props.autoFocus ? { 'data-autofocus': '' } : {})}
      end={
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label={show ? 'Hide password' : 'Show password'}
          data-testid={`${props.testid}-toggle`}
          onClick={() => setShow((s) => !s)}
        >
          {show ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
        </button>
      }
    />
  );
}

export function StrengthMeter({ password, testid }: { password: string; testid: string }) {
  const s = passwordStrength(password);
  return (
    <div className="protect-redact-strength" data-testid={testid} data-score={s.score} aria-live="polite">
      <div className="protect-redact-strength-bars" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={`protect-redact-strength-bar${s.score >= i ? ` is-on is-s${s.score}` : ''}`} />
        ))}
      </div>
      <div className="protect-redact-strength-text">
        {s.label ? <b className={`is-s${s.score}`}>{s.label}</b> : <span>Password strength</span>}
        {s.hint && <span className="protect-redact-strength-hint">{s.hint}</span>}
      </div>
    </div>
  );
}

function PermissionsFields({ value, onChange }: { value: PermissionChoices; onChange(v: PermissionChoices): void }) {
  return (
    <div className="protect-redact-perms">
      <Select<PrintingChoice>
        label="Printing allowed"
        value={value.printing}
        options={PRINTING_OPTIONS}
        onChange={(printing) => onChange({ ...value, printing })}
        data-testid="protect-redact-printing"
      />
      <Select<ChangesChoice>
        label="Changes allowed"
        value={value.changes}
        options={CHANGES_OPTIONS}
        onChange={(changes) => onChange({ ...value, changes })}
        data-testid="protect-redact-changes"
      />
      <div data-testid="protect-redact-copying">
        <Checkbox
          label="Enable copying of text, images and other content"
          checked={value.copying}
          onChange={(copying) => onChange({ ...value, copying })}
        />
      </div>
      <div data-testid="protect-redact-screen-reader">
        <Checkbox
          label="Enable text access for screen reader devices for the visually impaired"
          checked={value.screenReader || value.copying}
          disabled={value.copying}
          onChange={(screenReader) => onChange({ ...value, screenReader })}
        />
      </div>
    </div>
  );
}

function ProtectDialog({ docId, mode, close }: { docId: DocId; mode: Mode; close(v?: boolean): void }) {
  const doc = getDoc(docId);
  const current = doc?.security ?? null;
  const [openPw, setOpenPw] = useState('');
  const [openConfirm, setOpenConfirm] = useState('');
  const [restrict, setRestrict] = useState(mode === 'restrict');
  const [advancedOpen, setAdvancedOpen] = useState(mode === 'restrict');
  const [permPw, setPermPw] = useState('');
  const [permConfirm, setPermConfirm] = useState('');
  const [choices, setChoices] = useState<PermissionChoices>(() =>
    current?.permissions ? permissionsToChoices(current.permissions) : { ...DEFAULT_CHOICES },
  );
  const [submitted, setSubmitted] = useState(false);

  const errors = useMemo(() => {
    const e: Record<string, string | undefined> = {};
    if (mode === 'password') {
      if (!openPw) e.openPw = 'Enter a password.';
      else if (openConfirm !== openPw) e.openConfirm = 'The passwords don’t match.';
    }
    if (restrict) {
      if (!permPw) e.permPw = 'Enter a permissions password.';
      else if (permConfirm !== permPw) e.permConfirm = 'The passwords don’t match.';
      const userPw = mode === 'password' ? openPw : current?.userPassword ?? '';
      if (permPw && userPw && permPw === userPw) e.permPw = 'The open password and the permissions password can’t be the same.';
    }
    return e;
  }, [mode, openPw, openConfirm, restrict, permPw, permConfirm, current]);
  const valid = Object.values(errors).every((x) => !x);
  const show = (k: 'openPw' | 'openConfirm' | 'permPw' | 'permConfirm'): string | undefined => {
    if (submitted) return errors[k];
    // Live feedback only where it can't be premature.
    if (k === 'openConfirm' && openConfirm && openConfirm.length >= openPw.length) return errors[k];
    if (k === 'permConfirm' && permConfirm && permConfirm.length >= permPw.length) return errors[k];
    if (k === 'permPw' && permPw) return errors[k];
    return undefined;
  };

  const submit = () => {
    setSubmitted(true);
    if (!valid) return;
    let next: SecuritySettings;
    if (mode === 'password') {
      next = restrict ? { userPassword: openPw, ownerPassword: permPw, permissions: choicesToPermissions(choices) } : { userPassword: openPw };
    } else {
      next = { ...(current?.userPassword ? { userPassword: current.userPassword } : {}), ownerPassword: permPw, permissions: choicesToPermissions(choices) };
    }
    setSecurityUndoable(docId, next, mode === 'password' ? 'Protect with password' : 'Restrict editing');
    close(true);
  };

  const title = mode === 'password' ? 'Protect using password' : 'Restrict editing';
  return (
    <Modal
      title={title}
      icon={mode === 'password' ? LockKeyhole : ShieldCheck}
      width={500}
      onClose={() => close(false)}
      className="protect-redact-dialog"
      footer={
        <>
          <Button onClick={() => close(false)} data-testid="protect-redact-protect-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={submitted && !valid} data-testid="protect-redact-protect-apply">
            Apply
          </Button>
        </>
      }
    >
      <form
        className="protect-redact-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') {
            e.preventDefault();
            submit();
          }
        }}
        data-testid={mode === 'password' ? 'protect-redact-password-dialog' : 'protect-redact-restrict-dialog'}
      >
        {mode === 'password' ? (
          <>
            <p className="protect-redact-lead">Anyone who opens this document will need to enter the password.</p>
            <PasswordInput label="Password" value={openPw} onChange={setOpenPw} testid="protect-redact-open-password" error={show('openPw')} autoFocus />
            <StrengthMeter password={openPw} testid="protect-redact-strength" />
            <PasswordInput label="Confirm password" value={openConfirm} onChange={setOpenConfirm} testid="protect-redact-open-confirm" error={show('openConfirm')} />
          </>
        ) : (
          <p className="protect-redact-lead">
            People can open the document without a password, but they need the permissions password to print, edit or copy
            beyond what you allow.
          </p>
        )}

        {mode === 'password' && (
          <button
            type="button"
            className="protect-redact-disclosure"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((o) => !o)}
            data-testid="protect-redact-advanced"
          >
            {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            Advanced options
          </button>
        )}
        {advancedOpen && (
          <div className="protect-redact-advanced">
            {mode === 'password' && (
              <div data-testid="protect-redact-restrict-toggle">
                <Checkbox
                  label="Restrict editing and printing of the document"
                  description="A password will be required to change these permission settings."
                  checked={restrict}
                  onChange={setRestrict}
                />
              </div>
            )}
            {restrict && (
              <>
                <PasswordInput
                  label="Permissions password"
                  value={permPw}
                  onChange={setPermPw}
                  testid="protect-redact-perm-password"
                  error={show('permPw')}
                  autoFocus={mode === 'restrict'}
                />
                {mode === 'restrict' && <StrengthMeter password={permPw} testid="protect-redact-perm-strength" />}
                <PasswordInput label="Confirm permissions password" value={permConfirm} onChange={setPermConfirm} testid="protect-redact-perm-confirm" error={show('permConfirm')} />
                <PermissionsFields value={choices} onChange={setChoices} />
              </>
            )}
            <div className="protect-redact-encryption" data-testid="protect-redact-encryption-level">
              <span>Encryption level</span>
              <b>256-bit AES</b>
              <small>AES-256, readable by PDF viewers from 2011 on</small>
            </div>
          </div>
        )}
        {mode === 'password' && current && (current.userPassword || current.ownerPassword) && (
          <p className="protect-redact-note">This replaces the document’s current security settings.</p>
        )}
        <p className="protect-redact-note">Security is applied when you save or download the document.</p>
      </form>
    </Modal>
  );
}

export async function openProtectDialog(docId: DocId, mode: Mode): Promise<boolean> {
  const ok = await actions.openModal<boolean>((close) => <ProtectDialog docId={docId} mode={mode} close={close} />);
  if (ok) {
    actions.toast(
      mode === 'password' ? 'Password protection added. Save or download the document to apply it.' : 'Editing restrictions added. Save or download the document to apply them.',
      { kind: 'success' },
    );
  }
  return !!ok;
}
