import { useState } from 'react';
import { Download, HardDrive, Send, Share2 } from 'lucide-react';
import { actions } from '@/core/store';
import { Button, Modal } from '@/core/ui';
import { downloadBlob, formatBytes } from '@/core/util';
/** The system share sheet can take this file (Chrome/Edge on Windows and macOS, Safari). */
function shareableFile(name: string, bytes: Uint8Array): File | null {
  const file = new File([bytes as BlobPart], name, { type: 'application/pdf' });
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }) ? file : null;
  } catch {
    return null;
  }
}

function SendCopyBody({ name, bytes, close }: { name: string; bytes: Uint8Array; close(): void }) {
  const [file] = useState(() => shareableFile(name, bytes));
  const share = async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: name });
      close();
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') actions.toast(`Couldn't share: ${(e as Error).message}`, { kind: 'error' });
    }
  };
  const download = () => {
    downloadBlob(bytes, name);
    close();
  };
  return (
    <Modal
      title="Send a copy"
      icon={Send}
      iconColor="var(--accent)"
      width={520}
      onClose={close}
      className="share-dialog"
      footer={
        <Button variant="secondary" onClick={close}>
          Cancel
        </Button>
      }
    >
      <p className="share-dialog-file ellipsis" title={name}>
        {name} <span className="muted small">· {formatBytes(bytes.length)}</span>
      </p>
      <div className="share-dialog-access">
        <span className="share-dialog-access-icon">
          <HardDrive size={18} strokeWidth={1.75} />
        </span>
        <div>
          <div className="bold">Your files never leave this computer</div>
          <div className="muted small">
            PDF Wizard has no server. To get the PDF to someone, attach it to an email, a Teams message or a shared drive the way you
            normally would. Digital signatures in the file stay valid.
          </div>
        </div>
      </div>
      <div className="share-dialog-link">
        {file && (
          <Button variant="primary" icon={Share2} onClick={() => void share()} data-autofocus="" data-testid="share-system">
            Share…
          </Button>
        )}
        <Button variant={file ? 'secondary' : 'primary'} icon={Download} onClick={download} data-testid="share-download" {...(file ? {} : { 'data-autofocus': '' })}>
          Download a copy
        </Button>
      </div>
    </Modal>
  );
}

export function openSendCopyDialog(opts: { name: string; bytes: Uint8Array }) {
  return actions.openModal<void>((close) => <SendCopyBody name={opts.name} bytes={opts.bytes} close={() => close()} />);
}
