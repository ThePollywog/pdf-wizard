/** Left panel of the "Redact a PDF" task, and the options bar of the mark tool. */
import { useMemo } from 'react';
import {
  CheckCheck, EyeOff, FileX2, Info, ScanSearch, Settings2, ShieldCheck, SquareDashed, TextCursorInput, Trash2, X,
} from 'lucide-react';
import { actions, useApp, useDoc, useToolOptions } from '@/core/store';
import type { DocId } from '@/core/types';
import { Button, ColorSwatchButton, EmptyState, IconButton } from '@/core/ui';
import { PanelAction } from '../protect/ProtectPanel';
import { plural, useReadOnlyReason, useSharedViewOnly } from '../shared';
import { applyRedactions } from './apply';
import { FindPanel } from './FindPanel';
import { clearAllMarks, marksOf } from './marks';
import { openPagesDialog } from './pagesDialog';
import { openPropertiesDialog } from './PropertiesDialog';
import { openSanitizeDialog } from './SanitizeDialog';
import { MARK_DEFAULTS, MARK_TOOL, type MarkDefaults, type RedactionObject } from './types';
import { redactUi, useRedactUi } from './uiStore';

const MODE_ICON = { text: TextCursorInput, area: SquareDashed, page: FileX2 } as const;

function MarkRow({ docId, mark, pageNumber, selected }: { docId: DocId; mark: RedactionObject; pageNumber: number; selected: boolean }) {
  const hovered = useRedactUi((s) => s.hoverId === mark.id);
  const Icon = MODE_ICON[mark.data.mode] ?? SquareDashed;
  const label = mark.data.mode === 'page' ? 'Whole page' : mark.data.text || 'Area';
  const select = () => {
    actions.setTool('select');
    actions.setSelection(docId, [mark.id]);
    actions.goToPage(docId, pageNumber - 1, { rect: mark.rect, behavior: 'smooth' });
  };
  return (
    <li
      className={`protect-redact-mark-row${selected ? ' is-selected' : ''}${hovered ? ' is-hover' : ''}`}
      data-testid="protect-redact-mark-item"
      data-mark-id={mark.id}
      onPointerEnter={() => redactUi.setHover(mark.id)}
      onPointerLeave={() => redactUi.setHover(null)}
    >
      <button type="button" className="protect-redact-mark-row-main" onClick={select} data-testid="protect-redact-mark-item-open">
        <span className="protect-redact-mark-swatch" style={{ borderColor: mark.color ?? undefined, background: mark.fillColor ?? 'transparent' }} aria-hidden>
          <Icon size={12} strokeWidth={2} />
        </span>
        <span className="protect-redact-mark-row-text" title={label}>
          {label}
        </span>
        <span className="protect-redact-mark-row-page">p. {pageNumber}</span>
      </button>
      <IconButton
        size="sm"
        icon={X}
        label="Remove mark"
        onClick={() => actions.deleteObjects(docId, [mark.id], { label: 'Remove redaction mark' })}
        data-testid="protect-redact-mark-item-remove"
      />
    </li>
  );
}

function MarksList({ docId, disabled }: { docId: DocId; disabled: boolean }) {
  const objects = useDoc(docId, (d) => d?.objects);
  const order = useDoc(docId, (d) => d?.order);
  const pages = useDoc(docId, (d) => d?.pages);
  const selection = useDoc(docId, (d) => d?.selection);
  const marks = useMemo(
    () => (objects && order && pages ? marksOf({ objects, order, pages } as Parameters<typeof marksOf>[0]) : []),
    [objects, order, pages],
  );
  const pageNo = useMemo(() => new Map((pages ?? []).map((p, i) => [p.id, i + 1])), [pages]);
  const selected = new Set(selection ?? []);
  const pageCount = new Set(marks.map((m) => m.pageId)).size;
  return (
    <section className="panel-section protect-redact-section" data-testid="protect-redact-marks">
      <div className="panel-section-title protect-redact-section-title">
        <span>Marked for redaction</span>
        <span className="protect-redact-badge" data-testid="protect-redact-mark-count">
          {marks.length}
        </span>
        <span className="protect-redact-grow" />
        {marks.length > 0 && (
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void clearAllMarks(docId)} data-testid="protect-redact-clear-all">
            Clear all
          </Button>
        )}
      </div>
      {marks.length === 0 ? (
        <p className="protect-redact-muted" data-testid="protect-redact-marks-empty">
          Nothing is marked yet. Select text, drag over images or areas, mark whole pages, or search for text to mark.
        </p>
      ) : (
        <>
          <p className="protect-redact-muted">
            {plural(marks.length, 'mark')} on {plural(pageCount, 'page')}. Marked content is removed only when you apply redactions.
          </p>
          <ul className="protect-redact-mark-list">
            {marks.map((m) => (
              <MarkRow key={m.id} docId={docId} mark={m} pageNumber={pageNo.get(m.pageId) ?? 0} selected={selected.has(m.id)} />
            ))}
          </ul>
        </>
      )}
      <Button
        variant="primary"
        icon={CheckCheck}
        className="protect-redact-wide"
        disabled={disabled || marks.length === 0}
        onClick={() => void applyRedactions(docId)}
        data-testid="protect-redact-apply"
      >
        Apply redactions
      </Button>
    </section>
  );
}

export function RedactPanel() {
  const docId = useApp((s) => s.activeDocId);
  const tool = useApp((s) => s.activeToolId);
  const view = useRedactUi((s) => s.view);
  const readOnly = useReadOnlyReason(docId);
  const sharedViewOnly = useSharedViewOnly(docId);
  if (!docId) {
    return (
      <div className="protect-redact-panel">
        <EmptyState icon={EyeOff} title="No document open" description="Open a PDF to redact sensitive content." compact />
      </div>
    );
  }
  if (view === 'find') {
    return (
      <div className="protect-redact-panel" data-testid="protect-redact-redact-panel">
        <FindPanel docId={docId} />
      </div>
    );
  }
  const disabled = !!readOnly;
  return (
    <div className="protect-redact-panel" data-testid="protect-redact-redact-panel">
      <p className="protect-redact-intro">Mark text, images or pages to remove permanently, then apply the redactions.</p>
      {readOnly && (
        <div className="protect-redact-notice" role="status" data-testid="protect-redact-readonly">
          <Info size={16} aria-hidden />
          <span>{readOnly}</span>
        </div>
      )}
      {!readOnly && sharedViewOnly && (
        <div className="protect-redact-notice" role="status" data-testid="protect-redact-shared-notice">
          <Info size={16} aria-hidden />
          <span>This document was shared with you as view only. Redactions are applied to your copy.</span>
        </div>
      )}
      <div className="protect-redact-actions">
        <PanelAction
          icon={TextCursorInput}
          label="Redact text & images"
          description="Select text, or drag to mark an area."
          active={tool === MARK_TOOL}
          disabled={disabled}
          onClick={() => actions.setTool(tool === MARK_TOOL ? 'select' : MARK_TOOL)}
          testid="protect-redact-tool-mark"
        />
        <PanelAction
          icon={FileX2}
          label="Redact pages"
          description="Mark the current page, a range, or even/odd pages."
          disabled={disabled}
          onClick={() => void openPagesDialog(docId)}
          testid="protect-redact-tool-pages"
        />
        <PanelAction
          icon={ScanSearch}
          label="Find text & redact"
          description="Words, phrases or patterns like phone numbers."
          disabled={disabled}
          onClick={() => redactUi.setView('find')}
          testid="protect-redact-open-find"
        />
        <PanelAction
          icon={Settings2}
          label="Set properties"
          description="Fill color, overlay text and redaction codes for new marks."
          onClick={() => void openPropertiesDialog(docId, [])}
          testid="protect-redact-open-properties"
        />
      </div>
      <MarksList docId={docId} disabled={disabled} />
      <section className="panel-section protect-redact-section">
        <div className="panel-section-title">Hidden information</div>
        <PanelAction
          icon={ShieldCheck}
          label="Remove hidden information"
          description="Metadata, comments, attachments, hidden text, layers…"
          disabled={disabled}
          onClick={() => void openSanitizeDialog(docId)}
          testid="protect-redact-sanitize"
        />
      </section>
    </div>
  );
}

/** Options bar of the "Redact text & images" tool: defaults for new marks. */
export function MarkOptionsBar() {
  const o = useToolOptions<MarkDefaults>(MARK_TOOL, MARK_DEFAULTS);
  const docId = useApp((s) => s.activeDocId);
  const count = useDoc(docId, (d) => (d ? marksOf(d).length : 0));
  return (
    <div className="protect-redact-options" data-testid="protect-redact-options">
      <span className="protect-redact-options-label">Fill</span>
      <span data-testid="protect-redact-options-fill">
        <ColorSwatchButton size="sm" label="Redacted area fill color" allowNone value={o.fillColor ?? null} onChange={(hex) => actions.setToolOption(MARK_TOOL, 'fillColor', hex)} />
      </span>
      <span className="protect-redact-options-label">Outline</span>
      <span data-testid="protect-redact-options-outline">
        <ColorSwatchButton size="sm" label="Mark outline color" value={o.outlineColor} onChange={(hex) => hex && actions.setToolOption(MARK_TOOL, 'outlineColor', hex)} />
      </span>
      <IconButton size="sm" icon={Settings2} label="Redaction properties…" onClick={() => void openPropertiesDialog(docId, [])} data-testid="protect-redact-options-properties" />
      <span className="protect-redact-options-hint">Select text, or drag over an area. Hold Alt to drag over text.</span>
      {docId && (
        <Button size="sm" variant="primary" icon={CheckCheck} disabled={!count} onClick={() => void applyRedactions(docId)} data-testid="protect-redact-options-apply">
          Apply{count ? ` (${count})` : ''}
        </Button>
      )}
    </div>
  );
}
