/** "Insert blank pages" dialog: how many, where, and the page size. */
import { useState } from 'react';
import { FilePlus2 } from 'lucide-react';
import type { DocId } from '@/core/types';
import { actions, getDoc } from '@/core/store';
import { Button, Modal, NumberField, SegmentedControl, Select } from '@/core/ui';
import { indexOf, positionFor, PositionFields, type Position } from './PositionFields';

export interface BlankRequest {
  at: number;
  count: number;
  size?: { width: number; height: number };
}

type SizeKey = 'same' | 'letter' | 'legal' | 'tabloid' | 'a3' | 'a4' | 'a5';

/** Portrait sizes in points. */
const SIZES: Record<Exclude<SizeKey, 'same'>, { label: string; w: number; h: number }> = {
  letter: { label: 'Letter (8.5 × 11 in)', w: 612, h: 792 },
  legal: { label: 'Legal (8.5 × 14 in)', w: 612, h: 1008 },
  tabloid: { label: 'Tabloid (11 × 17 in)', w: 792, h: 1224 },
  a3: { label: 'A3 (297 × 420 mm)', w: 841.89, h: 1190.55 },
  a4: { label: 'A4 (210 × 297 mm)', w: 595.28, h: 841.89 },
  a5: { label: 'A5 (148 × 210 mm)', w: 419.53, h: 595.28 },
};

function shownSize(docId: DocId, index: number) {
  const p = getDoc(docId)?.pages[index];
  if (!p) return undefined;
  const swap = p.rotation % 180 !== 0;
  return swap ? { width: p.height, height: p.width } : { width: p.width, height: p.height };
}

const inches = (pt: number) => `${Math.round((pt / 72) * 100) / 100}`;

function BlankBody({ docId, defaultAt, close }: { docId: DocId; defaultAt: number; close(r: BlankRequest | null): void }) {
  const count = getDoc(docId)?.pages.length ?? 0;
  const [pos, setPos] = useState<Position>(() => positionFor(defaultAt, count));
  const [n, setN] = useState(1);
  const [size, setSize] = useState<SizeKey>('same');
  const [orient, setOrient] = useState<'portrait' | 'landscape'>('portrait');
  const at = indexOf(pos, count);
  const near = Math.min(Math.max(0, at - 1), count - 1);
  const same = shownSize(docId, near);

  const submit = () => {
    let s: BlankRequest['size'];
    if (size === 'same') s = same;
    else {
      const d = SIZES[size];
      s = orient === 'portrait' ? { width: d.w, height: d.h } : { width: d.h, height: d.w };
    }
    close({ at, count: n, size: s });
  };

  return (
    <Modal
      title="Insert blank pages"
      icon={FilePlus2}
      width={480}
      onClose={() => close(null)}
      className="organize-dialog"
      footer={
        <>
          <Button onClick={() => close(null)} data-testid="organize-blank-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} data-testid="organize-blank-ok">
            Insert
          </Button>
        </>
      }
    >
      <form
        className="organize-dialog-form"
        data-testid="organize-blank-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="organize-dialog-row">
          <div data-testid="organize-blank-count">
            <NumberField label="Number of pages" value={n} onChange={setN} min={1} max={500} width={110} aria-label="Number of pages" />
          </div>
        </div>
        <PositionFields value={pos} onChange={setPos} count={count} testid="organize-blank" />
        <div className="organize-dialog-row">
          <Select<SizeKey>
            label="Page size"
            value={size}
            onChange={setSize}
            options={[
              { value: 'same', label: same ? `Same as page ${near + 1} (${inches(same.width)} × ${inches(same.height)} in)` : 'Same as the neighbouring page' },
              ...Object.entries(SIZES).map(([value, d]) => ({ value: value as SizeKey, label: d.label })),
            ]}
            data-testid="organize-blank-size"
          />
        </div>
        <div className="organize-dialog-row" data-testid="organize-blank-orientation">
          <SegmentedControl<'portrait' | 'landscape'>
            label="Orientation"
            value={orient}
            onChange={setOrient}
            disabled={size === 'same'}
            options={[
              { value: 'portrait', label: 'Portrait' },
              { value: 'landscape', label: 'Landscape' },
            ]}
          />
        </div>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

export function insertBlankDialog(docId: DocId, defaultAt: number): Promise<BlankRequest | null> {
  return actions
    .openModal<BlankRequest | null>((close) => <BlankBody docId={docId} defaultAt={defaultAt} close={close} />)
    .then((r) => r ?? null);
}
