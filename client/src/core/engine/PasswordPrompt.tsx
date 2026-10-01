/** Default password provider: the standard "Password" dialog. */
import { useState } from 'react';
import { Lock } from 'lucide-react';
import { actions } from '../store';
import { Button, Modal, TextField } from '../ui';

function PasswordBody({ fileName, retry, close }: { fileName: string; retry: boolean; close(v: string | null): void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(retry);
  const submit = () => {
    if (value) close(value);
  };
  return (
    <Modal
      title="Password"
      icon={Lock}
      width={440}
      onClose={() => close(null)}
      footer={
        <>
          <Button onClick={() => close(null)} data-testid="password-cancel">
            Cancel
          </Button>
          <Button variant="primary" disabled={!value} onClick={submit} data-testid="password-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="dialog-message dialog-message-above">
        “{fileName}” is protected. Enter a Document Open Password.
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          type="password"
          label="Enter Password"
          value={value}
          onChange={(v) => {
            setValue(v);
            setError(false);
          }}
          autoComplete="off"
          data-autofocus=""
          error={error ? 'Incorrect password. Try again.' : null}
          data-testid="password-input"
        />
      </form>
    </Modal>
  );
}

/** Ask for a document open password. Resolves with null when the user cancels. */
export function passwordPrompt(fileName: string, retry: boolean): Promise<string | null> {
  return actions
    .openModal<string | null>((close) => <PasswordBody fileName={fileName} retry={retry} close={close} />, { dismissable: true })
    .then((v) => (typeof v === 'string' ? v : null));
}
