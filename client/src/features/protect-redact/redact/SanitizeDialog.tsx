/**
 * "Remove hidden information" dialog: examines the document, lists what was found and removes the
 * checked kinds of information in one undoable step.
 */
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { actions, getDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { Button, Checkbox, Modal, Spinner } from '@/core/ui';
import { FEATURE, errorMessage, plural, readOnlyReason } from '../shared';
import { SANITIZE_ITEMS, examineDocument, sanitizeDocument, type Findings, type SanitizeKey } from './sanitize';

type Result = SanitizeKey[] | undefined;

const RESULT_WORDS: Record<SanitizeKey, [string, string]> = {
  metadata: ['metadata entry', 'metadata entries'],
  attachments: ['attachment', 'attachments'],
  comments: ['comment', 'comments'],
  forms: ['form field', 'form fields'],
  hiddenText: ['hidden text run', 'hidden text runs'],
  layers: ['hidden layer', 'hidden layers'],
  bookmarks: ['bookmark', 'bookmarks'],
  links: ['link or action', 'links and actions'],
  searchIndex: ['private data item', 'private data items'],
  cropped: ['page with cropped content', 'pages with cropped content'],
};

function countLabel(key: SanitizeKey, n: number): string {
  if (!n) return 'None found';
  const [one, many] = RESULT_WORDS[key];
  return `${n} ${n === 1 ? one : many}`;
}

function SanitizeDialog({ docId, close }: { docId: DocId; close(v?: Result): void }) {
  const [findings, setFindings] = useState<Findings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<SanitizeKey>>(new Set());

  useEffect(() => {
    let live = true;
    examineDocument(docId)
      .then((f) => {
        if (!live) return;
        setFindings(f);
        setChecked(new Set(SANITIZE_ITEMS.filter((i) => f[i.key] > 0).map((i) => i.key)));
      })
      .catch((e) => {
        if (!live) return;
        console.warn(`[${FEATURE}] examine failed`, e);
        setError(errorMessage(e));
        setFindings({} as Findings);
        setChecked(new Set(SANITIZE_ITEMS.map((i) => i.key)));
      });
    return () => {
      live = false;
    };
  }, [docId]);

  const toggle = (k: SanitizeKey, on: boolean) =>
    setChecked((s) => {
      const n = new Set(s);
      if (on) n.add(k);
      else n.delete(k);
      return n;
    });
  const allOn = checked.size === SANITIZE_ITEMS.length;
  const found = findings ? SANITIZE_ITEMS.filter((i) => (findings[i.key] ?? 0) > 0).length : 0;

  return (
    <Modal
      title="Remove hidden information"
      icon={ShieldCheck}
      width={560}
      onClose={() => close(undefined)}
      className="protect-redact-dialog"
      footerStart={
        findings ? (
          <span data-testid="protect-redact-sanitize-all">
            <Checkbox
              label="Select all"
              checked={allOn}
              indeterminate={!allOn && checked.size > 0}
              onChange={(on) => setChecked(on ? new Set(SANITIZE_ITEMS.map((i) => i.key)) : new Set())}
            />
          </span>
        ) : undefined
      }
      footer={
        <>
          <Button onClick={() => close(undefined)} data-testid="protect-redact-sanitize-cancel">
            Cancel
          </Button>
          <Button variant="primary" disabled={!findings || checked.size === 0} onClick={() => close([...checked])} data-testid="protect-redact-sanitize-apply">
            Remove
          </Button>
        </>
      }
    >
      <div className="protect-redact-sanitize" data-testid="protect-redact-sanitize-dialog">
        <p className="protect-redact-lead">
          Documents can contain information that isn’t visible on the pages. Select what to remove — you can undo this until you save
          the document.
        </p>
        {!findings ? (
          <div className="protect-redact-sanitize-loading" data-testid="protect-redact-sanitize-loading">
            <Spinner size={18} /> Examining the document…
          </div>
        ) : (
          <>
            {error ? (
              <p className="protect-redact-note is-error">Couldn’t examine the document ({error}). Everything selected will still be removed.</p>
            ) : (
              <p className="protect-redact-note" data-testid="protect-redact-sanitize-summary">
                {found ? `Found ${plural(found, 'kind')} of hidden information.` : 'No hidden information was found.'}
              </p>
            )}
            <ul className="protect-redact-sanitize-list">
              {SANITIZE_ITEMS.map((item) => {
                const n = findings[item.key] ?? 0;
                return (
                  <li key={item.key} className={n ? 'has-findings' : undefined}>
                    <span data-testid={`protect-redact-sanitize-${item.key}`} data-count={n}>
                      <Checkbox label={item.label} description={item.description} checked={checked.has(item.key)} onChange={(on) => toggle(item.key, on)} />
                    </span>
                    {!error && <span className="protect-redact-sanitize-count">{countLabel(item.key, n)}</span>}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Open the dialog; resolves true when information was removed. */
export async function openSanitizeDialog(docId: DocId): Promise<boolean> {
  if (!getDoc(docId)) return false;
  const reason = readOnlyReason(docId);
  if (reason) {
    actions.toast(reason, { kind: 'error' });
    return false;
  }
  const keys = await actions.openModal<Result>((close) => <SanitizeDialog docId={docId} close={close} />);
  if (!keys?.length) return false;
  try {
    const res = await sanitizeDocument(docId, keys);
    const parts = keys.filter((k) => res[k] > 0).map((k) => countLabel(k, res[k]));
    actions.toast(parts.length ? `Removed ${parts.join(', ')}.` : 'Hidden information removed.', { kind: 'success' });
    return true;
  } catch (e) {
    console.warn(`[${FEATURE}] sanitize failed`, e);
    actions.toast(`Couldn’t remove hidden information: ${errorMessage(e)}`, { kind: 'error' });
    return false;
  }
}
