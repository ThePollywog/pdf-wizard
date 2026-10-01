import { useEffect, useState } from 'react';
import { CircleX } from 'lucide-react';
import { library } from '@/core/library';
import { formatBytes } from '@/core/util';
import { useRegistry } from '@/core/registry';
import { actions } from '@/core/store';
import { Button, Modal } from '@/core/ui';
import { WizardLogo } from '../Logo';

function AboutBody({ close }: { close(): void }) {
  const loaded = useRegistry((s) => s.loaded);
  const failed = useRegistry((s) => s.failed);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof library.usage>> | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    library.usage().then((u) => alive && setUsage(u));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Modal title="About PDF Wizard" width={500} onClose={close} className="about-dialog" footer={<Button variant="primary" onClick={close}>Close</Button>}>
      <div className="about-hero">
        <WizardLogo size={56} />
        <div>
          <div className="about-name">PDF Wizard</div>
          <div className="muted">View, fill, edit and digitally sign PDFs in your browser.</div>
        </div>
      </div>
      <div className="about-block">
        <div className="about-block-title">Features</div>
        <div className="muted small">
          {loaded.length} loaded{failed.length ? `, ${failed.length} failed to load` : ''}
        </div>
        {failed.length > 0 && (
          <ul className="about-failed">
            {failed.map((f) => (
              <li key={f.id} title={f.error}>
                <CircleX size={14} /> {f.id}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="about-block">
        <div className="about-block-title">Storage</div>
        <div className="muted small">
          Everything runs in this browser; files are kept on this computer only.
          {usage ? ` Using ${formatBytes(usage.used)} of ${formatBytes(usage.quota)}${usage.persisted ? ' (protected from automatic cleanup)' : ''}.` : ''}
        </div>
      </div>
    </Modal>
  );
}

export function openAbout() {
  return actions.openModal<void>((close) => <AboutBody close={() => close()} />);
}
