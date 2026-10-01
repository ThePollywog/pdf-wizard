/** Left panel of the "Fill & Sign" task. */
import { useEffect } from 'react';
import { CalendarDays, ChevronDown, ChevronUp, Eraser, FileSignature, Info, Plus, Signature, Trash2, Type, type LucideIcon } from 'lucide-react';
import type { DocId } from '@/core/types';
import { actions, useApp, useDoc } from '@/core/store';
import * as engine from '@/core/engine';
import { Button, EmptyState, IconButton, Switch, confirmDialog } from '@/core/ui';
import { clearForm, moveField, useFormInfo } from './forms';
import { MARK_ICONS } from './marks';
import { MARK_LABELS, type MarkKind, type SigRole } from './model';
import { MARK_TOOLS, TOOL_DATE, TOOL_INITIALS, TOOL_SIGNATURE, TOOL_TEXT } from './options';
import { SigImage } from './signature';
import { openSignatureManager } from './SignatureManager';
import { deleteSig, setHighlight, setPending, useFillSign, type SavedSig } from './store';

/** Documents for which the "no form fields" hint was shown since the task was opened. */
const hinted = new Set<DocId>();
export function resetHints() {
  hinted.clear();
}

const NO_FIELDS = 'This document has no fillable form fields — click anywhere to add text';

interface ToolButton {
  id: string;
  label: string;
  icon: LucideIcon | (typeof MARK_ICONS)[MarkKind];
}

const TEXT_TOOLS: ToolButton[] = [
  { id: TOOL_TEXT, label: 'Add text', icon: Type },
  { id: TOOL_DATE, label: 'Date', icon: CalendarDays },
  ...Object.entries(MARK_TOOLS).map(([id, m]) => ({ id, label: MARK_LABELS[m], icon: MARK_ICONS[m] })),
];

function ToolButtons({ toolId, disabled }: { toolId: string; disabled: boolean }) {
  return (
    <div className="fill-sign-tools" role="group" aria-label="Text and symbols">
      {TEXT_TOOLS.map((t) => {
        const active = toolId === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            className={`fill-sign-tool${active ? ' is-active' : ''}`}
            aria-pressed={active}
            data-testid={`fill-sign-add-${t.id}`}
            title={t.label}
            disabled={disabled}
            onClick={() => actions.setTool(active ? 'select' : t.id)}
          >
            <Icon size={18} strokeWidth={1.8} />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function roleTool(role: SigRole) {
  return role === 'initials' ? TOOL_INITIALS : TOOL_SIGNATURE;
}

async function addNew(role: SigRole) {
  const s = await openSignatureManager(role);
  if (s) actions.setTool(roleTool(role));
}

async function removeSaved(role: SigRole, sig: SavedSig) {
  const noun = role === 'initials' ? 'initials' : 'signature';
  const ok = await confirmDialog({
    title: `Delete ${noun}`,
    message: `Delete this saved ${noun}? Items already placed in documents are not affected.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  deleteSig(role, sig.id);
  actions.toast(role === 'initials' ? 'Initials deleted' : 'Signature deleted', { kind: 'success' });
}

function SignGroup({ role, toolId, disabled }: { role: SigRole; toolId: string; disabled: boolean }) {
  const saved = useFillSign((s) => s.saved[role]);
  const pending = useFillSign((s) => s.pending[role]);
  const tool = roleTool(role);
  const noun = role === 'initials' ? 'initials' : 'signature';
  const items: SavedSig[] = pending && !pending.saved ? [...saved, pending] : saved;
  return (
    <div className="fill-sign-sign-group" data-testid={`fill-sign-group-${role}`}>
      {items.map((s, i) => {
        const active = toolId === tool && pending?.id === s.id;
        return (
          <div key={s.id} className={`fill-sign-saved${active ? ' is-active' : ''}`}>
            <button
              type="button"
              className="fill-sign-saved-use"
              data-testid={`fill-sign-saved-${role}-${i}`}
              title={s.saved ? `Place this ${noun}` : `Place this ${noun} (not saved)`}
              aria-label={`Place ${noun} ${i + 1}`}
              disabled={disabled}
              onClick={() => {
                setPending(role, s);
                actions.setTool(tool);
              }}
            >
              <SigImage src={s.src} recolorable={s.recolorable} color={s.color} className="fill-sign-sig-fill" />
            </button>
            {s.saved ? (
              <IconButton icon={Trash2} size="sm" label={`Delete ${noun}`} onClick={() => void removeSaved(role, s)} data-testid={`fill-sign-delete-${role}-${i}`} />
            ) : (
              <span className="fill-sign-saved-tag" title="Used for this session only">
                Not saved
              </span>
            )}
          </div>
        );
      })}
      <Button
        variant="secondary"
        size="sm"
        icon={Plus}
        className="fill-sign-add-sig"
        disabled={disabled}
        onClick={() => void addNew(role)}
        data-testid={role === 'initials' ? 'fill-sign-add-initials' : 'fill-sign-add-signature'}
      >
        {role === 'initials' ? 'Add initials' : 'Add signature'}
      </Button>
    </div>
  );
}

function FormSection({ docId, count }: { docId: DocId; count: number }) {
  const highlight = useFillSign((s) => s.highlight);
  return (
    <section className="panel-section fill-sign-section" data-testid="fill-sign-forms">
      <div className="panel-section-title">Fill in form fields</div>
      <p className="fill-sign-count" data-testid="fill-sign-field-count">
        {count} form field{count === 1 ? '' : 's'}
      </p>
      <div className="fill-sign-row">
        <Button size="sm" variant="secondary" icon={ChevronUp} onClick={() => void moveField(docId, -1)} data-testid="fill-sign-field-prev">
          Previous
        </Button>
        <Button size="sm" variant="secondary" icon={ChevronDown} onClick={() => void moveField(docId, 1)} data-testid="fill-sign-field-next">
          Next
        </Button>
      </div>
      <div className="fill-sign-row" data-testid="fill-sign-highlight">
        <Switch label="Highlight fields" checked={highlight} onChange={setHighlight} />
      </div>
      <p className="fill-sign-hint">Tab and Shift+Tab move between fields. Required fields are outlined in red.</p>
      <Button size="sm" variant="ghost" icon={Eraser} className="fill-sign-clear" onClick={() => void clearForm(docId)} data-testid="fill-sign-clear-form">
        Clear form
      </Button>
    </section>
  );
}

export function FillSignPanel() {
  const docId = useApp((s) => s.activeDocId);
  const toolId = useApp((s) => s.activeToolId);
  const loadError = useDoc(docId, (d) => d?.loadError ?? null);
  const info = useFormInfo(docId);
  const readOnly = !!docId && engine.isReadOnly(docId);
  const count = info?.count ?? 0;

  // Documents without fields: say so once and get the user typing right away.
  useEffect(() => {
    if (!docId || !info || info.count > 0 || hinted.has(docId) || readOnly) return;
    hinted.add(docId);
    actions.toast(NO_FIELDS, { kind: 'info' });
    if (useApp.getState().activeToolId === 'select') actions.setTool(TOOL_TEXT);
  }, [docId, info, readOnly]);

  if (!docId) {
    return (
      <div className="fill-sign-panel">
        <EmptyState icon={FileSignature} title="No document open" description="Open a PDF to fill in forms and sign it." compact />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="fill-sign-panel">
        <EmptyState icon={FileSignature} title="The document could not be loaded" description={loadError} compact />
      </div>
    );
  }

  return (
    <div className="fill-sign-panel" data-testid="fill-sign-panel">
      {readOnly && (
        <div className="fill-sign-notice" role="status" data-testid="fill-sign-readonly">
          <Info size={16} aria-hidden />
          <span>This document is read-only. Form fields can be viewed, but text and signatures can’t be added.</span>
        </div>
      )}
      {count > 0 && <FormSection docId={docId} count={count} />}
      <section className="panel-section fill-sign-section">
        <div className="panel-section-title">Add text and symbols</div>
        <ToolButtons toolId={toolId} disabled={readOnly} />
        {count === 0 && info && !readOnly && <p className="fill-sign-hint">No fillable form fields. Click anywhere on the page to add text.</p>}
      </section>
      <section className="panel-section fill-sign-section">
        <div className="panel-section-title">
          <Signature size={14} aria-hidden /> Sign yourself
        </div>
        <SignGroup role="signature" toolId={toolId} disabled={readOnly} />
        <SignGroup role="initials" toolId={toolId} disabled={readOnly} />
      </section>
    </div>
  );
}
