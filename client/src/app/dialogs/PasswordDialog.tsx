import { useState } from 'react';
import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { actions } from '@/core/store';
import { Button, Modal, TextField } from '@/core/ui';

function PasswordBody({ fileName, retry, close }: { fileName: string; retry: boolean; close(v: string | null): void }) {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const submit = () => {
    if (pw) close(pw);
  };
  return (
    <Modal
      title="Password required"
      icon={LockKeyhole}
      width={440}
      onClose={() => close(null)}
      className="password-dialog"
      footer={
        <>
          <Button onClick={() => close(null)} data-testid="password-cancel">
            Cancel
          </Button>
          <Button variant="primary" disabled={!pw} onClick={submit} data-testid="password-submit">
            Open
          </Button>
        </>
      }
    >
      <p className="dialog-message-above">
        <b className="password-dialog-name">{fileName}</b> is protected. Enter the password to open it.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Password"
          type={show ? 'text' : 'password'}
          value={pw}
          onChange={setPw}
          autoComplete="off"
          data-autofocus=""
          data-testid="password-input"
          error={retry ? 'Incorrect password, try again' : undefined}
          end={
            <button type="button" className="icon-btn icon-btn-sm" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((s) => !s)}>
              {show ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
            </button>
          }
        />
      </form>
    </Modal>
  );
}

/** Password provider for engine.setPasswordProvider. */
export function askPassword(fileName: string, retry: boolean): Promise<string | null> {
  return actions
    .openModal<string | null>((close) => <PasswordBody fileName={fileName} retry={retry} close={close} />)
    .then((r) => (typeof r === 'string' && r ? r : null));
}
