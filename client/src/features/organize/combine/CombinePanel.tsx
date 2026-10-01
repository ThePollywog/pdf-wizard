/** Left panel of "Combine files" (when a document is open): the file order and the Combine button. */
import { Combine, FolderOpen, Upload } from 'lucide-react';
import { actions, useApp } from '@/core/store';
import { Button } from '@/core/ui';
import { formatBytes } from '@/core/util';
import { plural } from '../ranges';
import { combine, useCombine } from './store';
import { TASK_COMBINE } from '../tasks';

export function CombinePanel() {
  const files = useCombine((s) => s.files);
  const loading = useCombine((s) => s.loading);
  const total = files.reduce((n, f) => n + f.entries.length, 0);
  const ready = files.filter((f) => f.entries.length).length >= 2 && loading === 0;
  return (
    <div className="organize-panel" data-testid="organize-combine-panel">
      <div className="organize-panel-summary">
        <div className="organize-panel-count">{files.length ? plural(files.length, 'file', 'files') : 'No files yet'}</div>
        <div className="organize-panel-sub">{files.length ? `${plural(total, 'page', 'pages')} in the combined PDF` : 'Add at least two files'}</div>
      </div>
      <section className="organize-panel-section">
        <h3>Add files</h3>
        <ul className="organize-panel-actions">
          <li>
            <button type="button" className="organize-panel-action" onClick={() => void combine.pickFromDevice()} data-testid="organize-combine-panel-device">
              <Upload size={18} strokeWidth={1.75} />
              <span>From this device</span>
            </button>
          </li>
          <li>
            <button type="button" className="organize-panel-action" onClick={() => void combine.pickFromLibrary()} data-testid="organize-combine-panel-library">
              <FolderOpen size={18} strokeWidth={1.75} />
              <span>From your files</span>
            </button>
          </li>
        </ul>
      </section>
      {files.length > 0 && (
        <section className="organize-panel-section">
          <h3>Order</h3>
          <ol className="organize-combine-order">
            {files.map((f) => (
              <li key={f.key} title={f.name}>
                <span className="organize-combine-order-name">{f.name}</span>
                <span className="organize-panel-sub">
                  {plural(f.entries.length, 'page', 'pages')} · {formatBytes(f.size)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className="organize-panel-footer">
        <Button
          variant="primary"
          icon={Combine}
          disabled={!ready}
          onClick={() =>
            void combine.run(() => {
              if (useApp.getState().activeTaskId === TASK_COMBINE) actions.openTask(null);
            })
          }
          data-testid="organize-combine-panel-run"
        >
          Combine
        </Button>
      </div>
    </div>
  );
}
