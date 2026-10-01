/**
 * "Page numbering" dialog (the standard Page Labels): pick a page range, then begin a new section
 * (style, prefix, start) or extend the preceding numbering. Written to the catalog /PageLabels
 * number tree, so the labels appear in the grid, the viewer and every PDF reader.
 */
import { useState } from 'react';
import { ListOrdered, Trash2 } from 'lucide-react';
import type { DocId } from '@/core/types';
import { actions, getDoc } from '@/core/store';
import { Button, Modal, NumberField, RadioGroup, Select, TextField, confirmDialog } from '@/core/ui';
import { LABEL_STYLES, applyLabels, removeAllLabels, samplePreview, type LabelChange, type LabelStyle } from '../labels';
import { plural } from '../ranges';
import { attempt } from '../util';

interface LabelsResult {
  kind: 'apply' | 'remove';
  from: number;
  to: number;
  change: LabelChange;
}

function LabelsBody({ docId, indices, close }: { docId: DocId; indices: number[]; close(r: LabelsResult | null): void }) {
  const doc = getDoc(docId);
  const count = doc?.pages.length ?? 0;
  const lo = indices.length ? Math.min(...indices) : 0;
  const hi = indices.length ? Math.max(...indices) : count - 1;
  const [scope, setScope] = useState<'all' | 'range'>(indices.length && indices.length < count ? 'range' : 'all');
  const [from, setFrom] = useState(lo + 1);
  const [to, setTo] = useState(hi + 1);
  const [mode, setMode] = useState<'new' | 'extend'>('new');
  const [style, setStyle] = useState<LabelStyle>('D');
  const [prefix, setPrefix] = useState('');
  const [start, setStart] = useState(1);
  const hasLabels = !!doc?.pages.some((p, i) => p.label !== undefined && p.label !== String(i + 1));

  const a = scope === 'all' ? 1 : Math.max(1, Math.min(from, count));
  const b = scope === 'all' ? count : Math.max(1, Math.min(to, count));
  const error = b < a ? 'The last page must come after the first page.' : null;
  const prevLabel = a > 1 ? (doc?.pages[a - 2]?.label ?? String(a - 1)) : null;

  const submit = () => {
    if (error) return;
    const change: LabelChange = mode === 'new' ? { kind: 'new', style, prefix, start: Math.max(1, Math.round(start)) } : { kind: 'extend' };
    close({ kind: 'apply', from: a - 1, to: b - 1, change });
  };

  return (
    <Modal
      title="Page numbering"
      icon={ListOrdered}
      width={520}
      onClose={() => close(null)}
      className="organize-dialog"
      footerStart={
        hasLabels ? (
          <Button
            variant="ghost"
            icon={Trash2}
            onClick={() => close({ kind: 'remove', from: 0, to: 0, change: { kind: 'extend' } })}
            data-testid="organize-labels-remove"
          >
            Remove all labels
          </Button>
        ) : undefined
      }
      footer={
        <>
          <Button onClick={() => close(null)} data-testid="organize-labels-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!!error} data-testid="organize-labels-ok">
            OK
          </Button>
        </>
      }
    >
      <form
        className="organize-dialog-form"
        data-testid="organize-labels-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <fieldset className="organize-dialog-fieldset">
          <legend>Pages</legend>
          <div data-testid="organize-labels-scope">
            <RadioGroup<'all' | 'range'>
              value={scope}
              onChange={setScope}
              horizontal
              options={[
                { value: 'all', label: `All pages (${count})` },
                { value: 'range', label: 'Page range' },
              ]}
            />
          </div>
          <div className="organize-dialog-row">
            <div data-testid="organize-labels-from">
              <NumberField label="From" value={a} onChange={(v) => { setScope('range'); setFrom(Math.round(v)); }} min={1} max={count} width={96} aria-label="From page" />
            </div>
            <div data-testid="organize-labels-to">
              <NumberField label="To" value={b} onChange={(v) => { setScope('range'); setTo(Math.round(v)); }} min={1} max={count} width={96} suffix={`of ${count}`} aria-label="To page" />
            </div>
          </div>
          {error && (
            <div className="organize-dialog-error" role="alert">
              {error}
            </div>
          )}
        </fieldset>
        <fieldset className="organize-dialog-fieldset">
          <legend>Numbering</legend>
          <div data-testid="organize-labels-mode">
            <RadioGroup<'new' | 'extend'>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'new', label: 'Begin new section' },
                {
                  value: 'extend',
                  label: 'Extend numbering used in the preceding section',
                  description: prevLabel !== null ? `Continues after page ${a - 1} (labelled “${prevLabel}”).` : 'Starts at 1 because the range begins on the first page.',
                },
              ]}
            />
          </div>
          {mode === 'new' && (
            <div className="organize-labels-section">
              <Select<LabelStyle> label="Style" value={style} onChange={setStyle} options={LABEL_STYLES} data-testid="organize-labels-style" />
              <TextField label="Prefix" value={prefix} onChange={setPrefix} placeholder="e.g. A-" data-testid="organize-labels-prefix" />
              <div data-testid="organize-labels-start">
                <NumberField label="Start" value={start} onChange={(v) => setStart(Math.max(1, Math.round(v)))} min={1} max={99999} width={96} aria-label="Start number" />
              </div>
            </div>
          )}
          <div className="organize-labels-sample" data-testid="organize-labels-sample">
            <span className="organize-dialog-muted">Sample:</span>{' '}
            {mode === 'new' ? samplePreview(style, prefix, Math.max(1, start)) : prevLabel !== null ? `${prevLabel} → continues…` : '1, 2, 3, …'}
            <span className="organize-dialog-muted"> · {plural(error ? 0 : b - a + 1, 'page', 'pages')}</span>
          </div>
        </fieldset>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

export async function pageLabelsDialog(docId: DocId, indices: number[]): Promise<boolean> {
  const r = await actions.openModal<LabelsResult | null>((close) => <LabelsBody docId={docId} indices={indices} close={close} />);
  if (!r) return false;
  if (r.kind === 'remove') {
    const ok = await confirmDialog({
      title: 'Remove all page labels?',
      message: 'Pages will be numbered 1, 2, 3… again. You can undo this action.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return false;
    if (await attempt(() => removeAllLabels(docId))) {
      actions.toast('Page labels removed', { kind: 'success', action: { label: 'Undo', run: () => actions.undo(docId) } });
      return true;
    }
    return false;
  }
  if (await attempt(() => applyLabels(docId, r.from, r.to, r.change))) {
    const n = r.to - r.from + 1;
    actions.toast(`Page labels applied to ${plural(n, 'page', 'pages')}`, { kind: 'success', action: { label: 'Undo', run: () => actions.undo(docId) } });
    return true;
  }
  return false;
}
