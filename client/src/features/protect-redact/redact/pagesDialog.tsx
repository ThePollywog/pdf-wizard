/**
 * "Redact pages" (mark whole pages: current page, a range, even/odd pages) and
 * "Repeat mark across pages" dialogs.
 */
import { useMemo, useState } from 'react';
import { Copy, FileX2 } from 'lucide-react';
import { actions, getDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { Button, Modal, Radio, Select, TextField } from '@/core/ui';
import { formatPageRanges, parsePageRanges } from '@/core/util';
import { plural, readOnlyReason } from '../shared';
import { markPages, repeatMark } from './marks';
import { isRedaction } from './types';

type Which = 'current' | 'all' | 'range';
type Subset = 'all' | 'even' | 'odd';

const SUBSETS: { value: Subset; label: string }[] = [
  { value: 'all', label: 'All pages in range' },
  { value: 'even', label: 'Even pages only' },
  { value: 'odd', label: 'Odd pages only' },
];

function pick(which: Which, range: string, subset: Subset, current: number, count: number, exclude?: number): number[] {
  let list: number[];
  if (which === 'current') list = [current];
  else if (which === 'all') list = Array.from({ length: count }, (_, i) => i);
  else list = parsePageRanges(range, count);
  if (which !== 'current') {
    if (subset === 'even') list = list.filter((i) => (i + 1) % 2 === 0);
    else if (subset === 'odd') list = list.filter((i) => (i + 1) % 2 === 1);
  }
  return exclude === undefined ? list : list.filter((i) => i !== exclude);
}

function PageChoice(props: {
  mode: 'pages' | 'repeat';
  count: number;
  current: number;
  exclude?: number;
  close(v?: number[]): void;
}) {
  const { mode, count, current, exclude } = props;
  const [which, setWhich] = useState<Which>(mode === 'repeat' ? 'all' : 'current');
  const [range, setRange] = useState(count > 1 ? `1-${count}` : '1');
  const [subset, setSubset] = useState<Subset>('all');
  const pages = useMemo(() => pick(which, range, subset, current, count, exclude), [which, range, subset, current, count, exclude]);
  const rangeError = which === 'range' && range.trim() && !parsePageRanges(range, count).length ? `Enter pages between 1 and ${count}, e.g. 1-3, 5.` : undefined;
  const ok = pages.length > 0;
  const submit = () => ok && props.close(pages);
  const name = `protect-redact-pages-${mode}`;
  const choices: { value: Which; label: string }[] = mode === 'repeat'
    ? [
        { value: 'all', label: `All pages (${count})` },
        { value: 'range', label: 'Pages' },
      ]
    : [
        { value: 'current', label: `Current page (${current + 1})` },
        { value: 'all', label: `All pages (${count})` },
        { value: 'range', label: 'Pages' },
      ];

  return (
    <Modal
      title={mode === 'pages' ? 'Redact pages' : 'Repeat mark across pages'}
      icon={mode === 'pages' ? FileX2 : Copy}
      width={440}
      onClose={() => props.close(undefined)}
      className="protect-redact-dialog"
      footer={
        <>
          <Button onClick={() => props.close(undefined)} data-testid="protect-redact-pages-cancel">
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok} onClick={submit} data-testid="protect-redact-pages-ok">
            {mode === 'pages' ? 'Mark pages' : 'Repeat mark'}
          </Button>
        </>
      }
    >
      <form
        className="protect-redact-form"
        data-testid={mode === 'pages' ? 'protect-redact-pages-dialog' : 'protect-redact-repeat-dialog'}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="protect-redact-lead">
          {mode === 'pages'
            ? 'The whole content of the chosen pages is marked for redaction. Pages keep their size; after applying they are blank.'
            : 'The mark is copied to the same position on the chosen pages.'}
        </p>
        <div className="protect-redact-radios" role="radiogroup" aria-label="Pages">
          {choices.map((c) => (
            <span key={c.value} data-testid={`protect-redact-pages-${c.value}`}>
              <Radio name={name} value={c.value} label={c.label} checked={which === c.value} onChange={() => setWhich(c.value)} />
            </span>
          ))}
        </div>
        {which === 'range' && (
          <TextField
            label="Page range"
            value={range}
            onChange={setRange}
            placeholder={`e.g. 1-3, 5, 8-${count}`}
            error={rangeError}
            data-testid="protect-redact-pages-range-input"
            data-autofocus=""
          />
        )}
        {which !== 'current' && (
          <Select<Subset> label="Subset" value={subset} options={SUBSETS} onChange={setSubset} data-testid="protect-redact-pages-subset" />
        )}
        <p className="protect-redact-note" data-testid="protect-redact-pages-summary">
          {ok ? `${plural(pages.length, 'page')}: ${formatPageRanges(pages)}` : 'No pages selected.'}
        </p>
      </form>
    </Modal>
  );
}

/** "Redact pages": mark whole pages for redaction. */
export async function openPagesDialog(docId: DocId): Promise<number> {
  const doc = getDoc(docId);
  if (!doc) return 0;
  const reason = readOnlyReason(docId);
  if (reason) {
    actions.toast(reason, { kind: 'error' });
    return 0;
  }
  const pages = await actions.openModal<number[]>((close) => (
    <PageChoice mode="pages" count={doc.pages.length} current={Math.min(doc.view.currentPage, doc.pages.length - 1)} close={close} />
  ));
  if (!pages?.length) return 0;
  const n = markPages(docId, pages);
  if (n) actions.toast(`Marked ${plural(n, 'page')} for redaction. Apply redactions to remove the content.`, { kind: 'info' });
  else actions.toast('Those pages are already marked for redaction.', { kind: 'info' });
  return n;
}

/** "Repeat mark across pages" for an area mark. */
export async function openRepeatDialog(docId: DocId, markId: string): Promise<number> {
  const doc = getDoc(docId);
  const mark = doc?.objects[markId];
  if (!doc || !isRedaction(mark)) return 0;
  const reason = readOnlyReason(docId);
  if (reason) {
    actions.toast(reason, { kind: 'error' });
    return 0;
  }
  const own = doc.pages.findIndex((p) => p.id === mark.pageId);
  const pages = await actions.openModal<number[]>((close) => (
    <PageChoice mode="repeat" count={doc.pages.length} current={Math.max(0, own)} exclude={own} close={close} />
  ));
  if (!pages?.length) return 0;
  const n = repeatMark(docId, markId, pages);
  if (n) actions.toast(`Repeated the mark on ${plural(n, 'page')}.`, { kind: 'info' });
  return n;
}
