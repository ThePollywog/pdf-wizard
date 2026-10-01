/** "Insert pages" dialog shown after choosing a file: where to insert, and which of its pages. */
import { useState } from 'react';
import { FileInput } from 'lucide-react';
import type { DocId } from '@/core/types';
import { actions, getDoc } from '@/core/store';
import { Button, Modal, RadioGroup, TextField } from '@/core/ui';
import { parseRanges, plural } from '../ranges';
import { indexOf, positionFor, PositionFields, type Position } from './PositionFields';

export interface InsertPositionRequest {
  docId: DocId;
  sourceName: string;
  /** Page count of the single source; null for several files (no range choice). */
  pageCount: number | null;
  totalPages: number;
  defaultAt: number;
}

export interface InsertPositionResult {
  at: number;
  /** 0-based source pages (single source only); undefined = all. */
  pages?: number[];
}

function InsertBody({ req, close }: { req: InsertPositionRequest; close(r: InsertPositionResult | null): void }) {
  const count = getDoc(req.docId)?.pages.length ?? 0;
  const [pos, setPos] = useState<Position>(() => positionFor(req.defaultAt, count));
  const [which, setWhich] = useState<'all' | 'range'>('all');
  const [range, setRange] = useState('');
  const n = req.pageCount;
  const parsed = n !== null && which === 'range' ? parseRanges(range, n) : null;
  const error = parsed && range.trim() ? parsed.error : parsed && !range.trim() ? 'Enter the pages to insert' : null;
  const chosen = parsed && !parsed.error ? parsed.indices.length : req.totalPages;

  const submit = () => {
    if (error) return;
    close({ at: indexOf(pos, count), pages: parsed && !parsed.error ? parsed.indices : undefined });
  };

  return (
    <Modal
      title="Insert pages"
      icon={FileInput}
      width={500}
      onClose={() => close(null)}
      className="organize-dialog"
      footer={
        <>
          <Button onClick={() => close(null)} data-testid="organize-insert-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!!error} data-testid="organize-insert-ok">
            Insert {plural(chosen, 'page', 'pages')}
          </Button>
        </>
      }
    >
      <form
        className="organize-dialog-form"
        data-testid="organize-insert-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="organize-dialog-source">
          <span className="organize-dialog-source-name" title={req.sourceName}>
            {req.sourceName}
          </span>
          <span className="organize-dialog-muted">{plural(req.totalPages, 'page', 'pages')}</span>
        </div>
        <PositionFields value={pos} onChange={setPos} count={count} testid="organize-insert" />
        {n !== null && n > 1 && (
          <div className="organize-dialog-block" data-testid="organize-insert-which">
            <RadioGroup<'all' | 'range'>
              label="Pages to insert"
              value={which}
              onChange={setWhich}
              horizontal
              options={[
                { value: 'all', label: 'All pages' },
                { value: 'range', label: 'Page range' },
              ]}
            />
            {which === 'range' && (
              <TextField
                label="Pages"
                value={range}
                onChange={setRange}
                placeholder={`e.g. 1-3, 5 (of ${n})`}
                error={range.trim() ? (error ?? undefined) : undefined}
                help={`Pages 1 to ${n} of the inserted file`}
                autoFocus
                data-testid="organize-insert-range"
              />
            )}
          </div>
        )}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

export function insertPositionDialog(req: InsertPositionRequest): Promise<InsertPositionResult | null> {
  return actions
    .openModal<InsertPositionResult | null>((close) => <InsertBody req={req} close={close} />)
    .then((r) => r ?? null);
}
