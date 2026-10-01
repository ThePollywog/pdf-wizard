/** "Extract pages" dialog: page range and the usual extract options. */
import { useState } from 'react';
import { FileOutput } from 'lucide-react';
import type { DocId } from '@/core/types';
import { actions, getDoc } from '@/core/store';
import { Button, Checkbox, Modal, RadioGroup, TextField } from '@/core/ui';
import { organize, useOrganize, type ExtractOutput } from '../store';
import { formatRanges, parseRanges, plural } from '../ranges';
import { readOnlyReason } from '../util';

export interface ExtractRequest {
  indices: number[];
  deleteAfter: boolean;
  separate: boolean;
  output: ExtractOutput;
}

function ExtractBody({ docId, indices, close }: { docId: DocId; indices: number[]; close(r: ExtractRequest | null): void }) {
  const doc = getDoc(docId);
  const count = doc?.pages.length ?? 0;
  const saved = useOrganize((s) => s.extract);
  const [range, setRange] = useState(() => formatRanges(indices.length ? indices : count ? [0] : []));
  const parsed = parseRanges(range, count);
  const error = range.trim() ? parsed.error : 'Enter the pages to extract';
  const n = parsed.error ? 0 : parsed.indices.length;
  const ro = readOnlyReason(docId);
  const all = n >= count;
  const canDelete = !ro && !all;
  const deleteAfter = saved.deleteAfter && canDelete;

  const submit = () => {
    if (error) return;
    close({ indices: parsed.indices, deleteAfter, separate: saved.separate && n > 1, output: saved.output });
  };

  const multi = saved.separate && n > 1;
  return (
    <Modal
      title="Extract pages"
      icon={FileOutput}
      width={500}
      onClose={() => close(null)}
      className="organize-dialog"
      footer={
        <>
          <Button onClick={() => close(null)} data-testid="organize-extract-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!!error} data-testid="organize-extract-ok">
            Extract
          </Button>
        </>
      }
    >
      <form
        className="organize-dialog-form"
        data-testid="organize-extract-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Pages to extract"
          value={range}
          onChange={setRange}
          placeholder={`e.g. 1-3, 5 (of ${count})`}
          error={range.trim() ? (error ?? undefined) : undefined}
          help={error ? `Pages 1 to ${count}` : `${plural(n, 'page', 'pages')} of ${count}`}
          autoFocus
          data-testid="organize-extract-range"
        />
        <div className="organize-dialog-block">
          <div data-testid="organize-extract-delete">
            <Checkbox
              label="Delete pages after extracting"
              checked={deleteAfter}
              disabled={!canDelete}
              onChange={(v) => organize.setExtract({ deleteAfter: v })}
              description={ro ? 'Not available: the document is read-only.' : all && n ? "Not available when extracting every page: a document can't be left empty." : undefined}
            />
          </div>
          <div data-testid="organize-extract-separate">
            <Checkbox
              label="Extract pages as separate files"
              checked={saved.separate}
              onChange={(v) => organize.setExtract({ separate: v })}
              description={saved.separate && n > 1 ? `Creates ${n} one-page PDFs.` : undefined}
            />
          </div>
        </div>
        <div className="organize-dialog-block" data-testid="organize-extract-output">
          <RadioGroup
            label="Output"
            value={saved.output}
            onChange={(output) => organize.setExtract({ output })}
            options={[
              { value: 'open', label: multi ? 'Open each file in a new tab' : 'Open in a new tab' },
              { value: 'download', label: multi ? 'Download as a ZIP archive' : 'Download the PDF' },
            ]}
          />
        </div>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

export function extractDialog(docId: DocId, indices: number[]): Promise<ExtractRequest | null> {
  return actions.openModal<ExtractRequest | null>((close) => <ExtractBody docId={docId} indices={indices} close={close} />).then((r) => r ?? null);
}
